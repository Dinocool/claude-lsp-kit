// The machine-wide lsp-kit manager: ONE language server per (language,
// checkout, client initializationOptions), shared by every Claude Code session
// on the machine. Each session's proxy.mjs connects to it over the endpoint in
// rpc.mjs and starts it (detached) when none answers. Several sessions on one
// checkout used to run one index each (rust-analyzer ~3.5 GB, LuaLS ~1.4 GB).
//
// Per server the manager fixes what Claude Code's client leaves out:
// 1. Watcher fallback. Claude Code's client does not advertise
//    `workspace.didChangeWatchedFiles`, so servers fall back to their own
//    whole-tree watchers (svelte-language-server's chokidar crawl starved the
//    server for minutes in a large repo) or never notice files changed on disk.
//    Every server is told the client supports it; changes come from ONE native
//    recursive fs.watch per server, skipping dot-directories, node_modules and
//    target.
// 2. Roots. Project config lives at the repo root (.luarc.json, the Cargo
//    workspace, svelte.config.*), and LuaLS reads .luarc.json only from its
//    workspace root. Every server is rooted at a git toplevel (gitRoot in
//    languages.mjs): a session's root is the toplevel of its client's folder,
//    and a file goes to the toplevel of the checkout that owns it.
// 3. Worktrees. Agents edit files in linked git worktrees (e.g.
//    .claude/worktrees/<name>, or a sibling directory), so an agent's LSP calls
//    see its worktree's code, not main's.
// 4. Per-language setup from languages.mjs (server command, initialization
//    options such as rust-analyzer's linkedProjects for nested crates, response
//    rewrites such as the Lua documentSymbol outline).
//
// Lifecycle, one rule for every server: it starts on the first request for its
// checkout; it stops after IDLE_MS unused or once its directory is gone; when a
// start would exceed MAX_SERVERS live servers, the least recently used one
// stops first. A server with a request in flight is never stopped (if every
// one has, the cap is exceeded and logged). A server that exits is dropped, and
// the next request for its checkout starts a fresh one (LSP 3.17: `initialize`
// goes once per process). The manager itself exits once it has neither
// sessions nor servers; a session's exit only releases its documents.
//
// Sessions, the LSP 3.17 client side of each server:
// - Ids: a session's request goes to the server under a manager id and its
//   answer back under the session's own id. Server->client requests are
//   answered here (the client capabilities are the starting session's, and no
//   single session owns a shared server).
// - Documents: a server has a document open once however many sessions opened
//   it (the spec allows one open at a time); its didClose goes out when the
//   last session closes it or disconnects. The server's copy is the session's
//   own while that session alone opened it; a didOpen or didChange from any
//   other session reloads it from disk (Claude Code's tools edit files on disk
//   before they notify). A request for a document the server doesn't have open
//   (fresh or restarted) opens it from disk first.
// - Diagnostics go to every session with the document open, else to every
//   session using the server.
// - Spelling: a session keeps its own spelling of a checkout's path (drive
//   case, 8.3 names, junctions). Documents reach the server respelled under the
//   server's root (rust-analyzer answers nothing for a document outside its
//   root's spelling); answers and diagnostics go back under the session's.
// - workspace/symbol asks the session root's server and every other live server
//   the session has used, and merges the answers; other workspace-wide
//   requests go to the session root's server.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, watch } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES, gitRoot } from './languages.mjs';
import { endpoint, frame, readFrames } from './rpc.mjs';

// Machine-wide, across sessions and languages. The cap stops a server only when
// MAX_SERVERS checkouts used more recently (the one starting included) need
// one, so no active work loses its navigation (lead's ruling); memory limits
// are not this rule's job.
const MAX_SERVERS = Number(process.env.LSP_KIT_MAX_SERVERS) || 10;
const IDLE_MS = Number(process.env.LSP_KIT_IDLE_MS) || 10 * 60 * 1000;
const STOP_KILL_MS = 5000; // a stopping server that hasn't exited by then is killed
const WATCHED_FILES = 'workspace/didChangeWatchedFiles';
const FILE_CHANGE = { Created: 1, Changed: 2, Deleted: 3 };
const CONTENT_MODIFIED = -32801;
const RETRY_MS = 500;
const RETRY_WINDOW_MS = 55 * 1000; // under Claude Code's 60 s request timeout
const DID_OPEN = 'textDocument/didOpen';
const DID_CHANGE = 'textDocument/didChange';
const DID_CLOSE = 'textDocument/didClose';

const { dir, path: PIPE, log: LOG } = endpoint();
const servers = new Map(); // share key -> live server
const running = new Set(); // every server whose process hasn't closed, stopping ones included
const sessions = new Set();
const pending = new Map(); // manager request id -> { id, session, clientId, server, msg, root, since }
let serverCount = 0;
let sessionCount = 0;
let ids = 0;

// ---- log, endpoint ------------------------------------------------------------

// Every line goes to the log file and to every session's proxy, which writes it
// to its stderr (Claude Code's LSP log).
function log(line, only) {
	const text = `lsp-kit: ${line}`;
	appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`);
	for (const s of only ? [only] : sessions) toSession(s, { jsonrpc: '2.0', method: 'lsp-kit/log', params: { line: text } });
}
// LSP_KIT_TRACE=1 logs every message's direction, server, method/id and error.
const trace = process.env.LSP_KIT_TRACE
	? (dir, no, msg) =>
			appendFileSync(LOG, `trace ${dir}#${no} ${msg.method ?? ''} ${msg.id ?? ''} ${docUri(msg.params) ?? ''} ${msg.error ? JSON.stringify(msg.error) : ''}\n`)
	: () => {};

process.on('uncaughtException', (e) => {
	appendFileSync(LOG, `${new Date().toISOString()} lsp-kit: manager crashed: ${e.stack}\n`);
	process.exit(1);
});

mkdirSync(dir, { recursive: true });
const listener = createServer(attach);
listener.on('error', (e) => {
	if (e.code !== 'EADDRINUSE') throw e;
	if (process.platform === 'win32') process.exit(0); // another manager owns the pipe
	// A Unix socket outlives a crashed owner (Node net docs): reclaim it only when
	// nothing answers on it. Two managers racing past a stale socket can both
	// listen; the one whose file was replaced keeps serving its sessions until
	// they reconnect, then exits when it has neither sessions nor servers.
	const probe = connect(PIPE);
	probe.once('connect', () => process.exit(0));
	probe.once('error', () => (unlinkSync(PIPE), listener.listen(PIPE)));
});
listener.listen(PIPE, () => {
	try {
		renameSync(LOG, LOG.replace(/\.log$/, '.previous.log'));
	} catch {} // no earlier log
	log(`manager pid ${process.pid} on ${PIPE} (cap ${MAX_SERVERS} servers, idle stop ${IDLE_MS / 1000} s)`);
});

// ---- servers ------------------------------------------------------------------

function startServer(session, root, key, shareKey) {
	const lang = session.lang;
	const server = { lang, root, key, shareKey, no: ++serverCount, docs: new Map(), requests: new Set(), lastUsed: Date.now(), waiting: new Map(), queue: [], ready: false };
	servers.set(shareKey, server);
	running.add(server);
	try {
		const { command, args } = lang.server(root);
		// cwd stays the manager's (the home directory): on Windows a process's cwd
		// can't be deleted, which would block removing the worktree. Servers take
		// their root from rootUri.
		server.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
		server.child.on('error', (e) => (server.startError = e.message));
		server.child.stdin.on('error', () => {}); // a write racing the child's exit; 'close' cleans up
		server.child.on('close', (code) => serverClosed(server, code));
		readFrames(server.child.stdout, (msg) => {
			try {
				fromServer(server, msg);
			} catch (e) {
				log(`${lang.name} server #${server.no}: dropped ${msg.method ?? `the answer to ${msg.id}`}: ${e.message}`);
			}
		});
	} catch (e) {
		server.startError = e.message;
		setImmediate(() => serverClosed(server));
	}
	log(`${lang.name} server #${server.no} for ${root} (${servers.size} live, pid ${server.child?.pid})`);

	const uri = pathToFileURL(root).href;
	const params = structuredClone(session.init ?? {});
	params.processId = process.pid; // LSP 3.17: the server exits if this process dies
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

// The process is gone: its sessions' requests fail with the reason, and the
// next request for its checkout starts a new server.
function serverClosed(server, code) {
	server.closed = true;
	running.delete(server);
	drop(server);
	server.exitMessage = `lsp-kit: ${server.lang.name} server #${server.no} for ${server.root} ${server.startError ? `could not start: ${server.startError}` : `exited (code ${code})`}`;
	for (const entry of server.requests) settle(entry, { error: { code: -32603, message: server.exitMessage } });
	for (const resolve of server.waiting.values()) resolve(null);
	log(server.exitMessage.replace(/^lsp-kit: /, ''));
}

// No new message reaches a stopping or closed server (LSP 3.17: nothing but
// `exit` after `shutdown`).
function drop(server) {
	if (servers.get(server.shareKey) === server) servers.delete(server.shareKey);
	server.watcher?.close();
	for (const s of sessions) s.uses.delete(server);
}

// A session's answer, or the server's exit message once it has closed.
const answer = (session, id, server, result) =>
	toSession(session, server.closed ? { jsonrpc: '2.0', id, error: { code: -32603, message: server.exitMessage } } : { jsonrpc: '2.0', id, result });

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
	const id = `kit:${++ids}`;
	const msg = { jsonrpc: '2.0', id, method, params };
	if (now) write(server, msg);
	else send(server, msg);
	return new Promise((resolve) => server.waiting.set(id, resolve));
}

// LSP 3.17: `shutdown`, then `exit` once it is answered. One still running
// after STOP_KILL_MS is killed.
function stopServer(server) {
	if (server.stopped) return;
	drop(server);
	log(`stopping ${server.lang.name} server #${server.no} for ${server.root}`);
	setTimeout(() => server.child?.kill(), STOP_KILL_MS).unref();
	server.stopped = request(server, 'shutdown', null).then(() => write(server, { jsonrpc: '2.0', method: 'exit', params: null }));
}

const busy = (server) => server.requests.size > 0 || server.waiting.size > 0;

// Room for one more server: least recently used first, never one with a request in flight.
function makeRoom() {
	const idle = [...servers.values()].filter((s) => !busy(s)).sort((a, b) => a.lastUsed - b.lastUsed);
	while (servers.size >= MAX_SERVERS && idle.length) stopServer(idle.shift());
	if (servers.size >= MAX_SERVERS) log(`every live server has a request in flight: ${servers.size + 1} exceed the cap of ${MAX_SERVERS}`);
}

setInterval(() => {
	for (const s of servers.values()) if ((!busy(s) && Date.now() - s.lastUsed > IDLE_MS) || !existsSync(s.root)) stopServer(s);
	// Unlisten first: a proxy that connects from now on starts a new manager.
	if (!sessions.size && !running.size) listener.close(() => process.exit(0));
}, Math.min(IDLE_MS, 60 * 1000));

// One key per checkout, however a client spells it (drive-letter case, 8.3
// short names, subst drives, junctions, symlinks): realpathSync.native is the
// true path (Node fs docs: realpath(3); libuv uv_fs_realpath:
// GetFinalPathNameByHandleW on Windows). Only the key is canonical: a server is
// rooted in the spelling of the session that started it (its own root's for
// its session root, else the first request's).
const keyOf = (root) => realpathSync.native(root);

// The session's server for a checkout root in the session's spelling, started if
// none runs. The share key: language, checkout and the client's own
// initializationOptions (the language's part derives from the checkout alone).
function serverFor(session, root) {
	const key = keyOf(root);
	if (key === session.rootKey) root = session.root;
	const shareKey = `${session.language}\n${key}\n${session.options}`;
	let server = servers.get(shareKey);
	if (!server) {
		makeRoom();
		server = startServer(session, root, key, shareKey);
	}
	session.uses.set(server, root);
	return server;
}

// ---- spelling -----------------------------------------------------------------

// `uri` (a file under `from`) respelled under `to`.
function respell(uri, from, to) {
	if (from === to || !uri.startsWith('file:')) return uri;
	const rel = relative(from, fileURLToPath(uri));
	return rel.startsWith('..') || isAbsolute(rel) ? uri : pathToFileURL(join(to, rel)).href;
}
// Every file URI in an answer (values and keys, e.g. WorkspaceEdit.changes)
// respelled from the server's root to the session's.
function respellAll(value, from, to) {
	if (from === to) return value;
	const walk = (v) =>
		typeof v === 'string'
			? respell(v, from, to)
			: Array.isArray(v)
				? v.map(walk)
				: v && typeof v === 'object'
					? Object.fromEntries(Object.entries(v).map(([k, x]) => [respell(k, from, to), walk(x)]))
					: v;
	return walk(value);
}
const withDocUri = (params, uri) =>
	params.textDocument ? { ...params, textDocument: { ...params.textDocument, uri } } : { ...params, item: { ...params.item, uri } };
// A server's documents are keyed by path (servers may spell a URI differently
// in diagnostics), case-folded where the file system is.
const docKey = (uri) => {
	if (!uri.startsWith('file:')) return uri;
	const path = fileURLToPath(uri);
	return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
};

// ---- sessions -> servers ------------------------------------------------------

function attach(socket) {
	const session = { no: ++sessionCount, socket, uses: new Map(), pending: new Map() }; // uses: server -> the session's spelling of its root
	sessions.add(session);
	socket.on('error', () => {}); // 'close' follows
	socket.on('close', () => detach(session));
	// A message the manager can't route (its checkout vanished mid-way) is
	// answered with the reason; the manager keeps serving.
	readFrames(socket, (msg) => {
		try {
			fromSession(session, msg);
		} catch (e) {
			log(`session #${session.no}: ${msg.method ?? 'response'} failed: ${e.message}`);
			if (msg.method && msg.id != null) toSession(session, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `lsp-kit: ${e.message}` } });
		}
	});
}

function toSession(session, msg) {
	if (!session.socket.writable) return;
	trace('<-', `s${session.no}`, msg);
	session.socket.write(frame(msg));
}

// The session's documents are released; its servers stay for other sessions.
function release(session) {
	for (const server of servers.values()) for (const key of [...server.docs.keys()]) closeDoc(server, key, session);
}
function detach(session) {
	sessions.delete(session);
	release(session);
}

// The proxy's first message. It carries the client's initialize params once
// the client has sent them, so a manager started after that serves the session.
function hello(session, { language, cwd, pid, initialize }) {
	Object.assign(session, { language, lang: LANGUAGES[language], cwd });
	log(`session #${session.no} (${session.lang.name}, pid ${pid}) joined manager pid ${process.pid}`, session);
	if (initialize) begin(session, initialize);
}

// The client's initialize params set the session's root.
function begin(session, params) {
	session.init = params;
	session.options = JSON.stringify(params.initializationOptions ?? null);
	const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
	const dir = folder ? fileURLToPath(folder) : session.cwd;
	session.root = gitRoot(dir) ?? dir;
	session.rootKey = keyOf(session.root);
}

const docUri = (params) => params?.textDocument?.uri ?? params?.item?.uri;

function fromSession(session, msg) {
	trace('=>', `s${session.no}`, msg);
	if (msg.method === 'lsp-kit/hello') return hello(session, msg.params);
	if (msg.method === 'initialize') {
		begin(session, msg.params);
		const home = serverFor(session, session.root);
		home.initialized.then((result) => answer(session, msg.id, home, result));
		return;
	}
	if (msg.method === 'initialized' || msg.method === 'exit' || !msg.method) return; // no server->client request reaches a session
	if (!session.root) throw new Error(`${msg.method} before initialize`);
	if (msg.method === 'shutdown') {
		release(session);
		toSession(session, { jsonrpc: '2.0', id: msg.id, result: null });
		return;
	}
	if (msg.method === '$/cancelRequest') {
		const entry = session.pending.get(msg.params?.id);
		if (!entry) return;
		// Between ContentModified retries the server has nothing left to cancel: answer here.
		if (entry.retrying) settle(entry, { error: { code: -32800, message: 'cancelled' } });
		else if (!entry.server.stopped) send(entry.server, { ...msg, params: { id: entry.id } });
		return;
	}
	const uri = docUri(msg.params);
	if (!uri) {
		if (msg.method === 'workspace/symbol') {
			// The session root's server (started if stopped) plus every other live one it has used.
			const home = serverFor(session, session.root);
			const asked = [...session.uses.keys()].filter((s) => s === home || s.ready);
			Promise.all(asked.map((s) => request(s, msg.method, msg.params).then((a) => respellAll(a ?? [], s.root, session.uses.get(s) ?? s.root)))).then((answers) =>
				answer(session, msg.id, home, answers.flat())
			);
		} else if (msg.method === 'workspace/didChangeConfiguration') for (const s of session.uses.keys()) send(s, msg);
		else route(session, serverFor(session, session.root), msg, session.root);
		return;
	}
	// The git toplevel owning the file, in the session's spelling, else the session root.
	const root = (uri.startsWith('file:') && gitRoot(dirname(fileURLToPath(uri)))) || session.root;
	// Closing never starts a server: a stopped one has nothing open.
	const server = msg.method === DID_CLOSE ? [...session.uses.keys()].find((s) => s.key === keyOf(root)) : serverFor(session, root);
	if (!server) return;
	const serverUri = respell(uri, root, server.root);
	if (serverUri !== uri) msg = { ...msg, params: withDocUri(msg.params, serverUri) };
	const key = docKey(serverUri);
	const doc = server.docs.get(key);
	const version = msg.params.textDocument?.version ?? 0;
	if (msg.method === DID_CLOSE) return closeDoc(server, key, session);
	if (!doc && msg.method === DID_OPEN) {
		server.docs.set(key, { uri: serverUri, holders: new Set([session]), owner: session, version });
		return send(server, msg);
	}
	if (msg.method === DID_CHANGE && doc?.owner === session) {
		doc.version = version;
		return send(server, msg);
	}
	const sync = msg.method === DID_OPEN || msg.method === DID_CHANGE;
	// The server's copy isn't this session's (or the server lacks the document):
	// load it from disk, which already holds any edit the session reports.
	if (sync || !doc) syncFromDisk(server, key, serverUri, version, session);
	if (!sync) route(session, server, msg, root);
}

// The server's copy of the document set to the file on disk, `session` among
// its holders. An open document gets the whole text as one change (LSP 3.17
// TextDocumentContentChangeEvent without a range), not a close and reopen:
// after a quick close and reopen, LuaLS's last diagnostics for the file came
// without its warnings in one of four test/shared.mjs runs.
function syncFromDisk(server, key, uri, version, session) {
	let text;
	try {
		text = readFileSync(fileURLToPath(uri), 'utf8');
	} catch {
		return;
	}
	const doc = server.docs.get(key);
	if (!doc) {
		server.docs.set(key, { uri, holders: new Set([session]), owner: null, version });
		return send(server, { jsonrpc: '2.0', method: DID_OPEN, params: { textDocument: { uri, languageId: server.lang.languageId, version, text } } });
	}
	doc.holders.add(session);
	doc.owner = null;
	send(server, { jsonrpc: '2.0', method: DID_CHANGE, params: { textDocument: { uri: doc.uri, version: ++doc.version }, contentChanges: [{ text }] } });
}

// The session no longer holds the document; the last holder's close reaches the server.
function closeDoc(server, key, session) {
	const doc = server.docs.get(key);
	if (!doc?.holders.delete(session)) return;
	if (doc.owner === session) doc.owner = null;
	if (doc.holders.size) return;
	server.docs.delete(key);
	send(server, { jsonrpc: '2.0', method: DID_CLOSE, params: { textDocument: { uri: doc.uri } } });
}

// A session request (or notification) to a server; `root` is the session's
// spelling of the server's checkout, for the answer.
function route(session, server, msg, root) {
	if (msg.id == null) return send(server, msg);
	const entry = { id: `kit:${++ids}`, session, clientId: msg.id, server, root, since: Date.now() };
	entry.msg = { ...msg, id: entry.id };
	pending.set(entry.id, entry);
	session.pending.set(msg.id, entry);
	server.requests.add(entry);
	send(server, entry.msg);
}

// The request is done: its answer (rewritten, respelled) goes to its session.
function settle(entry, reply) {
	pending.delete(entry.id);
	entry.session.pending.delete(entry.clientId);
	entry.server.requests.delete(entry);
	const rewrite = reply.result && entry.server.lang.results?.[entry.msg.method];
	const result = respellAll(rewrite ? rewrite(reply.result) : reply.result, entry.server.root, entry.root);
	toSession(entry.session, reply.error ? { jsonrpc: '2.0', id: entry.clientId, error: reply.error } : { jsonrpc: '2.0', id: entry.clientId, result });
}

// ---- servers -> sessions ------------------------------------------------------

// Server->client requests, answered here: no default (null) is wrong for these.
const SERVER_REQUESTS = {
	'workspace/configuration': (params) => params.items.map(() => null), // one null per item: "can't provide"
	'workspace/workspaceFolders': (params, server) => [{ uri: pathToFileURL(server.root).href, name: server.root.split(sep).pop() }]
};

function fromServer(server, msg) {
	trace('<=', server.no, msg);
	if (msg.id != null && !msg.method) {
		const resolve = server.waiting.get(msg.id);
		if (resolve) {
			server.waiting.delete(msg.id);
			resolve(msg.result);
			return;
		}
		const entry = pending.get(msg.id);
		if (!entry) return;
		// rust-analyzer answers ContentModified while it (re)loads the workspace; the
		// spec leaves the retry to the client, which Claude Code doesn't do.
		if (msg.error?.code === CONTENT_MODIFIED && Date.now() - entry.since < RETRY_WINDOW_MS) {
			entry.retrying = true;
			setTimeout(() => {
				if (pending.get(entry.id) !== entry) return;
				entry.retrying = false;
				send(server, entry.msg);
			}, RETRY_MS);
			return;
		}
		settle(entry, msg);
		return;
	}
	if (msg.id != null) return write(server, { jsonrpc: '2.0', id: msg.id, result: SERVER_REQUESTS[msg.method]?.(msg.params, server) ?? null });
	// Progress tokens are the manager's (it answered window/workDoneProgress/create).
	if (msg.method === '$/progress') return;
	const doc = msg.method === 'textDocument/publishDiagnostics' && server.docs.get(docKey(msg.params.uri));
	const to = doc ? doc.holders : [...sessions].filter((s) => s.uses.has(server));
	for (const s of to) toSession(s, respellAll(msg, server.root, s.uses.get(server) ?? server.root));
}

// ---- file watching ------------------------------------------------------------

function watchRoot(server) {
	const watchExts = new Set(server.lang.watch);
	let changed = new Map();
	let timer = null;
	try {
		server.watcher = watch(server.root, { recursive: true }, (event, filename) => {
			if (!filename) return;
			const parts = filename.split(/[\\/]/);
			if (parts.some((d) => d === 'node_modules' || d === 'target' || (d.startsWith('.') && d !== '.svelte-kit'))) return;
			const path = join(server.root, filename);
			const exists = existsSync(path);
			if (watchExts.has(extname(filename))) {
				changed.set(path, event === 'change' ? FILE_CHANGE.Changed : exists ? FILE_CHANGE.Created : FILE_CHANGE.Deleted);
			} else if (event === 'rename') {
				// A deleted or moved directory arrives as one event on the directory itself.
				if (!exists) changed.set(path, FILE_CHANGE.Deleted);
				else if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) changed.set(path, FILE_CHANGE.Created);
				else return;
			} else return;
			timer ??= setTimeout(() => {
				const changes = [...changed].map(([p, type]) => ({ uri: pathToFileURL(p).href, type }));
				changed = new Map();
				timer = null;
				if (servers.get(server.shareKey) === server) write(server, { jsonrpc: '2.0', method: WATCHED_FILES, params: { changes } });
			}, 50);
		});
		server.watcher.on('error', (e) => log(`watching ${server.root} failed: ${e.message}`));
	} catch (e) {
		log(`watching ${server.root} failed: ${e.message}`);
	}
}
