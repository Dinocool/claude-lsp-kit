// Stdio proxy between Claude Code's LSP client and one language server per
// git root. Usage: node proxy.mjs <language>   (a key of LANGUAGES)
//
// Claude Code starts one server per language, rooted at the session's working
// directory, which can be any subdirectory of the repo. The proxy fixes four
// problems with that:
//
// 1. Watcher fallback. Claude Code's client does not advertise
//    `workspace.didChangeWatchedFiles`, so servers fall back to their own
//    whole-tree watchers (svelte-language-server's chokidar crawl starved the
//    server for minutes in a large repo) or never notice files changed on disk.
//    Every server is told the client supports it; the proxy answers the
//    registration and feeds changes from ONE native recursive fs.watch per
//    server, skipping dot-directories, node_modules and target.
//
// 2. Roots. Project config lives at the repo root (.luarc.json, the Cargo
//    workspace, svelte.config.*), and LuaLS reads .luarc.json only from its
//    workspace root. Every server is rooted at a git toplevel (gitRoot in
//    languages.mjs): the session root is the toplevel of the client's folder,
//    and a file goes to the toplevel of the checkout that owns it.
//
// 3. Worktrees. Agents edit files in linked git worktrees (e.g.
//    .claude/worktrees/<name>, or a sibling directory), so an agent's LSP calls
//    see its worktree's code, not main's.
//
// Server lifecycle, one rule for every root (the session's own included): a
// server starts on the first request for its root; at most MAX_SERVERS run at
// once (least recently used stops first); each stops after IDLE_MS unused or
// once its directory is gone. A server that exits, crashes or is stopped is
// dropped, and the next request for its root starts a fresh one (LSP 3.17:
// the client owns the server lifecycle; `initialize` goes once per process).
// The proxy exits only on the client's `exit` or the end of its stdin, taking
// every server it started with it: Claude Code doesn't restart a proxy that
// exits cleanly. The client's `initialize` gets the session root's first
// server's result.
//
// 4. Per-language setup from languages.mjs (server command, initialization
//    options such as rust-analyzer's linkedProjects for nested crates, response
//    rewrites such as the Lua documentSymbol outline).
//
// A document routed to a server that doesn't have it open (fresh or
// restarted) is opened from disk first. workspace/symbol asks the session
// root's server and every other ready one and merges the answers; other
// workspace-wide requests go to the session root's server.
//
// Ids: client requests keep their ids (servers only see client ids plus the
// proxy's own string ids "kit:<n>"); server->client requests are re-keyed
// "<serverNo>:<id>" so the client's answers can be routed back.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES, gitRoot } from './languages.mjs';

// The session root's server counts: an index costs the same memory whichever
// checkout it covers (rust-analyzer ~3.5 GB, LuaLS ~1.4 GB), and every session
// runs its own proxy.
const MAX_SERVERS = 3;
// LSP_KIT_IDLE_MS: tests shorten the idle stop.
const IDLE_MS = Number(process.env.LSP_KIT_IDLE_MS) || 10 * 60 * 1000;
const STOP_KILL_MS = 5000; // a stopping server that hasn't exited by then is killed
const WATCHED_FILES = 'workspace/didChangeWatchedFiles';
const FILE_CHANGE = { Created: 1, Changed: 2, Deleted: 3 };
const CONTENT_MODIFIED = -32801;
const RETRY_MS = 500;
const RETRY_WINDOW_MS = 55 * 1000; // under Claude Code's 60 s request timeout

const lang = LANGUAGES[process.argv[2]];
if (!lang) throw new Error(`lsp-kit: unknown language "${process.argv[2]}"`);

const servers = new Map(); // git root -> server
const running = new Set(); // every server whose process hasn't closed, stopping ones included
const pendingClientRequests = new Map(); // client request id -> { server, msg, since }
let clientInit = null;
let sessionRoot = null;
let shutdownReceived = false;
let exiting = false;
let serverCount = 0;
let proxyIds = 0;

// ---- framing ----------------------------------------------------------------

const frame = (msg) => {
	const body = Buffer.from(JSON.stringify(msg), 'utf8');
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
};
// LSP_KIT_TRACE=1 logs every message's direction, server, method/id and error to stderr.
const trace = process.env.LSP_KIT_TRACE
	? (dir, no, msg) => process.stderr.write(`lsp-kit trace ${dir}#${no} ${msg.method ?? ''} ${msg.id ?? ''} ${msg.error ? JSON.stringify(msg.error) : ''}\n`)
	: () => {};
const toClient = (msg) => (trace('<-', '', msg), process.stdout.write(frame(msg)));

function readFrames(input, onMessage) {
	let buf = Buffer.alloc(0);
	input.on('data', (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			const headerEnd = buf.indexOf('\r\n\r\n');
			if (headerEnd < 0) return;
			const end = headerEnd + 4 + Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString('ascii'))?.[1]);
			if (Number.isNaN(end)) {
				buf = buf.subarray(headerEnd + 4); // no Content-Length: drop the header block
				continue;
			}
			if (buf.length < end) return;
			const body = buf.subarray(headerEnd + 4, end).toString('utf8');
			buf = buf.subarray(end);
			let msg;
			try {
				msg = JSON.parse(body);
			} catch {
				process.stderr.write(`lsp-kit: dropped a malformed message: ${body.slice(0, 120)}\n`);
				continue;
			}
			onMessage(msg);
		}
	});
}

// ---- servers ----------------------------------------------------------------

function startServer(root) {
	const server = { root, no: ++serverCount, openDocs: new Set(), lastUsed: Date.now(), waiting: new Map(), queue: [], ready: false };
	servers.set(root, server);
	running.add(server);
	try {
		const { command, args } = lang.server(root);
		// cwd stays the session root: on Windows a process's cwd can't be deleted, which
		// would block removing the worktree. Servers take their root from rootUri.
		server.child = spawn(command, args, { cwd: sessionRoot, stdio: ['pipe', 'pipe', 'inherit'] });
		server.child.on('error', (e) => (server.startError = e.message));
		server.child.stdin.on('error', () => {}); // a write racing the child's exit; 'close' cleans up
		server.child.on('close', (code) => serverClosed(server, code));
		readFrames(server.child.stdout, (msg) => fromServer(server, msg));
	} catch (e) {
		server.startError = e.message;
		setImmediate(() => serverClosed(server));
	}
	process.stderr.write(`lsp-kit: ${lang.name} server #${server.no} for ${root} (${servers.size} live, pid ${server.child?.pid})\n`);

	const uri = pathToFileURL(root).href;
	const params = structuredClone(clientInit.params ?? {});
	params.processId = process.pid;
	params.rootUri = uri;
	params.rootPath = root;
	params.workspaceFolders = [{ uri, name: root.split(sep).pop() }];
	params.capabilities ??= {};
	params.capabilities.workspace ??= {};
	params.capabilities.workspace.didChangeWatchedFiles = { dynamicRegistration: true };
	params.initializationOptions = { ...lang.initializationOptions?.(root), ...params.initializationOptions };
	server.initialized = request(server, 'initialize', params, true).then((result) => {
		if (server.closed) return;
		write(server, { jsonrpc: '2.0', method: 'initialized', params: {} });
		server.ready = true;
		for (const msg of server.queue.splice(0)) write(server, msg);
		watchRoot(server);
		return result;
	});
	return server;
}

// The process is gone: its client requests fail with the reason, and the next
// request for its root starts a new server.
function serverClosed(server, code) {
	server.closed = true;
	running.delete(server);
	if (servers.get(server.root) === server) servers.delete(server.root);
	server.watcher?.close();
	server.exitMessage = `lsp-kit: ${lang.name} server #${server.no} for ${server.root} ${server.startError ? `could not start: ${server.startError}` : `exited (code ${code})`}`;
	for (const [id, pending] of pendingClientRequests) {
		if (pending.server !== server) continue;
		pendingClientRequests.delete(id);
		answer(id, server);
	}
	for (const resolve of server.waiting.values()) resolve(null);
	process.stderr.write(server.exitMessage + '\n');
	if (exiting && !running.size) process.exit(exitCode());
}

// A client request's answer, or the server's exit message once it has closed.
const answer = (id, server, result) =>
	toClient(server.closed ? { jsonrpc: '2.0', id, error: { code: -32603, message: server.exitMessage } } : { jsonrpc: '2.0', id, result });

function write(server, msg) {
	trace('->', server.no, msg);
	if (server.child?.stdin.writable) server.child.stdin.write(frame(msg));
}

// Sends to a server once it is initialized (`initialize` itself goes out at once).
function send(server, msg) {
	server.lastUsed = Date.now();
	if (server.ready) write(server, msg);
	else server.queue.push(msg);
}

function request(server, method, params, now = false) {
	const id = `kit:${++proxyIds}`;
	const msg = { jsonrpc: '2.0', id, method, params };
	if (now) write(server, msg);
	else send(server, msg);
	return new Promise((resolve) => server.waiting.set(id, resolve));
}

// LSP 3.17: `shutdown`, then `exit` once it is answered. Resolves when the
// server has answered (or closed); one still running after STOP_KILL_MS is killed.
function stopServer(server) {
	if (server.stopped) return server.stopped;
	if (servers.get(server.root) === server) servers.delete(server.root);
	process.stderr.write(`lsp-kit: stopping ${lang.name} server #${server.no} for ${server.root}\n`);
	server.watcher?.close();
	setTimeout(() => server.child?.kill(), STOP_KILL_MS).unref();
	return (server.stopped = request(server, 'shutdown', null).then(() => write(server, { jsonrpc: '2.0', method: 'exit', params: null })));
}

// The client's `exit` or the end of stdin: every server this proxy started is
// stopped, and the proxy exits once all have closed. The ref'd timer bounds the
// wait should a killed server's pipes stay open.
const exitCode = () => (shutdownReceived ? 0 : 1); // LSP 3.17: 0 only after `shutdown`
function exitProxy() {
	exiting = true;
	for (const s of running) stopServer(s);
	if (!running.size) process.exit(exitCode());
	setTimeout(() => process.exit(exitCode()), STOP_KILL_MS + 1000);
}

// The git toplevel owning the file, else the session root. Matched to a live
// server's root ignoring case on Windows, where the client's and the server's
// spellings of a drive letter can differ.
const samePath = process.platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
function rootFor(uri) {
	const root = (uri?.startsWith('file:') && gitRoot(dirname(fileURLToPath(uri)))) || sessionRoot;
	return [...servers.keys()].find((k) => samePath(k, root)) ?? root;
}

function serverFor(root) {
	const existing = servers.get(root);
	if (existing) return existing;
	const live = [...servers.values()].sort((a, b) => a.lastUsed - b.lastUsed);
	while (live.length >= MAX_SERVERS) stopServer(live.shift());
	return startServer(root);
}

setInterval(() => {
	for (const s of servers.values()) if (Date.now() - s.lastUsed > IDLE_MS || !existsSync(s.root)) stopServer(s);
}, Math.min(IDLE_MS, 60 * 1000)).unref();

// ---- client -> servers ------------------------------------------------------

const docUri = (params) => params?.textDocument?.uri ?? params?.item?.uri;

readFrames(process.stdin, (msg) => {
	if (msg.method === 'initialize') {
		clientInit = msg;
		const folder = msg.params?.workspaceFolders?.[0]?.uri ?? msg.params?.rootUri;
		const dir = folder ? fileURLToPath(folder) : process.cwd();
		sessionRoot = gitRoot(dir) ?? dir;
		const home = startServer(sessionRoot);
		home.initialized.then((result) => answer(msg.id, home, result));
		return;
	}
	if (msg.method === 'initialized') return; // each server gets its own from the proxy
	if (msg.method === 'shutdown') {
		shutdownReceived = true;
		Promise.all([...running].map(stopServer)).then(() => toClient({ jsonrpc: '2.0', id: msg.id, result: null }));
		return;
	}
	if (msg.method === 'exit') {
		exitProxy();
		return;
	}
	if (msg.method === '$/cancelRequest') {
		const pending = pendingClientRequests.get(msg.params?.id);
		pendingClientRequests.delete(msg.params?.id);
		if (!pending) return;
		// Between ContentModified retries the server has nothing left to cancel: answer here.
		if (pending.retrying) toClient({ jsonrpc: '2.0', id: msg.params.id, error: { code: -32800, message: 'cancelled' } });
		else send(pending.server, msg);
		return;
	}
	if (!msg.method) {
		// The client's answer to a server request: id "<serverNo>:<id>".
		const match = /^(\d+):(.*)$/s.exec(String(msg.id));
		const s = match && [...servers.values()].find((x) => String(x.no) === match[1]);
		if (!s) return;
		try {
			send(s, { ...msg, id: JSON.parse(match[2]) });
		} catch {
			process.stderr.write(`lsp-kit: dropped a response with unknown id ${msg.id}\n`);
		}
		return;
	}
	const uri = docUri(msg.params);
	if (!uri) {
		if (msg.method === 'workspace/symbol') {
			// The session root's server (started if stopped) plus every other ready one.
			const home = serverFor(sessionRoot);
			const asked = new Set([home, ...[...servers.values()].filter((s) => s.ready)]);
			Promise.all([...asked].map((s) => request(s, msg.method, msg.params))).then((answers) =>
				answer(msg.id, home, answers.flatMap((a) => a ?? []))
			);
		} else if (msg.method === 'workspace/didChangeConfiguration') for (const s of servers.values()) send(s, msg);
		else route(serverFor(sessionRoot), msg);
		return;
	}
	if (msg.method === 'textDocument/didClose') {
		// Closing never starts a server: a stopped one has nothing open.
		const server = servers.get(rootFor(uri));
		if (server?.openDocs.delete(uri)) route(server, msg);
		return;
	}
	const server = serverFor(rootFor(uri));
	if (msg.method === 'textDocument/didOpen') server.openDocs.add(uri);
	else if (!server.openDocs.has(uri)) {
		// Opened on a server that has since stopped (or never had it): open from disk.
		// Disk already holds an edit the client reports, so a didChange is replaced.
		openFromDisk(server, uri, msg.params.textDocument?.version ?? 0);
		if (msg.method === 'textDocument/didChange') return;
	}
	route(server, msg);
});

function openFromDisk(server, uri, version) {
	let text;
	try {
		text = readFileSync(fileURLToPath(uri), 'utf8');
	} catch {
		return;
	}
	server.openDocs.add(uri);
	send(server, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: lang.languageId, version, text } } });
}

function route(server, msg) {
	if (msg.id != null) pendingClientRequests.set(msg.id, { server, msg, since: Date.now() });
	send(server, msg);
}

// ---- servers -> client ------------------------------------------------------

function fromServer(server, msg) {
	trace('<=', server.no, msg);
	if (msg.id != null && !msg.method) {
		const resolve = server.waiting.get(msg.id);
		if (resolve) {
			server.waiting.delete(msg.id);
			resolve(msg.result);
			return;
		}
		const pending = pendingClientRequests.get(msg.id);
		// rust-analyzer answers ContentModified while it (re)loads the workspace; the
		// spec leaves the retry to the client, which Claude Code doesn't do.
		if (pending && msg.error?.code === CONTENT_MODIFIED && Date.now() - pending.since < RETRY_WINDOW_MS) {
			pending.retrying = true;
			setTimeout(() => {
				if (pendingClientRequests.get(msg.id) !== pending) return;
				pending.retrying = false;
				send(pending.server, pending.msg);
			}, RETRY_MS);
			return;
		}
		pendingClientRequests.delete(msg.id);
		const rewrite = pending && msg.result && lang.results?.[pending.msg.method];
		toClient(rewrite ? { ...msg, result: rewrite(msg.result) } : msg);
		return;
	}
	if (msg.method === 'client/registerCapability') {
		const registrations = msg.params.registrations.filter((r) => r.method !== WATCHED_FILES);
		if (!registrations.length) {
			write(server, { jsonrpc: '2.0', id: msg.id, result: null });
			return;
		}
		msg = { ...msg, params: { registrations } };
	}
	toClient(msg.id != null ? { ...msg, id: `${server.no}:${JSON.stringify(msg.id)}` } : msg);
}

// ---- file watching ----------------------------------------------------------

function watchRoot(server) {
	const watchExts = new Set(lang.watch);
	let pending = new Map();
	let timer = null;
	try {
		server.watcher = watch(server.root, { recursive: true }, (event, filename) => {
			if (!filename) return;
			const parts = filename.split(/[\\/]/);
			if (parts.some((d) => d === 'node_modules' || d === 'target' || (d.startsWith('.') && d !== '.svelte-kit'))) return;
			const path = join(server.root, filename);
			const exists = existsSync(path);
			if (watchExts.has(extname(filename))) {
				pending.set(path, event === 'change' ? FILE_CHANGE.Changed : exists ? FILE_CHANGE.Created : FILE_CHANGE.Deleted);
			} else if (event === 'rename') {
				// A deleted or moved directory arrives as one event on the directory itself.
				if (!exists) pending.set(path, FILE_CHANGE.Deleted);
				else if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) pending.set(path, FILE_CHANGE.Created);
				else return;
			} else return;
			timer ??= setTimeout(() => {
				const changes = [...pending].map(([p, type]) => ({ uri: pathToFileURL(p).href, type }));
				pending = new Map();
				timer = null;
				if (servers.get(server.root) === server) write(server, { jsonrpc: '2.0', method: WATCHED_FILES, params: { changes } });
			}, 50);
		});
		server.watcher.on('error', (e) => process.stderr.write(`lsp-kit: watching ${server.root} failed: ${e.message}\n`));
	} catch (e) {
		process.stderr.write(`lsp-kit: watching ${server.root} failed: ${e.message}\n`);
	}
}

process.stdin.on('end', exitProxy);
