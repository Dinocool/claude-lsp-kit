// The machine-wide lsp-kit manager, shared by every Claude Code session on the
// machine. Each session's proxy.mjs connects to it over the endpoint in rpc.mjs
// and starts it (detached) when none answers. Several sessions on one checkout
// used to run one index each (rust-analyzer ~3.5 GB, LuaLS ~1.4 GB).
//
// Folders: a server serves a set of workspace folders, each a checkout's git
// toplevel, joined on its first request and left when unused (see reap). A
// shared language (`shared` in languages.mjs) runs ONE server per server binary
// for every checkout: on five checkouts of one repo it took a third (Rust) to
// two thirds (TypeScript, Svelte) of five servers' memory, with unsaved edits,
// references and workspace symbols kept per folder (measured). Any other
// language keys its server by checkout, a folder set of one.
//
// Per server the manager fixes what Claude Code's client leaves out:
// 1. Watcher fallback. Claude Code's client does not advertise
//    `workspace.didChangeWatchedFiles`, so servers fall back to their own
//    whole-tree watchers (svelte-language-server's chokidar crawl starved the
//    server for minutes in a large repo) or never notice files changed on disk.
//    Every server is told the client supports it; changes come from ONE native
//    recursive fs.watch per folder, skipping dot-directories, node_modules and
//    target.
// 2. Roots. Project config lives at the repo root (.luarc.json, the Cargo
//    workspace, svelte.config.*), and LuaLS reads .luarc.json only from its
//    workspace root. Every folder is a git toplevel (gitRoot in
//    languages.mjs): a session's root is the toplevel of its client's folder,
//    and a file goes to the toplevel of the checkout that owns it.
// 3. Worktrees. Agents edit files in linked git worktrees (e.g.
//    .claude/worktrees/<name>, or a sibling directory), so an agent's LSP calls
//    see its worktree's code, not main's.
// 4. Per-language setup from languages.mjs (server command, initialization
//    options such as rust-analyzer's linkedProjects for nested crates,
//    environment such as LuaLS's TMP in a folder of its own, response
//    rewrites such as the Lua documentSymbol outline).
//
// Lifecycle, one rule for every server: it starts on the first request for a
// folder it would serve; it stops when its last folder leaves; when a start
// would exceed MAX_SERVERS live servers, or the servers' memory exceeds
// MAX_MEMORY, the least recently used ones stop first (for the limit a shared
// server restarts with its live folders instead, and one serving only live
// folders stays). While the machine's free memory is under MIN_FREE, the least
// recently used server stops, one per reaper tick. A server in use (a request
// in flight, or used within the last reaper tick) is never stopped; if every
// one is, the cap or limit is exceeded and logged. A crashed server restarts
// (see serverClosed); else the next request starts a fresh one (LSP 3.17:
// `initialize` goes once per process). The manager itself exits once it has
// neither sessions nor servers; a session's exit only releases its documents.
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
//   session using the file's folder.
// - Spelling: a session keeps its own spelling of a checkout's path (drive
//   case, 8.3 names, junctions). Documents reach the server respelled under the
//   folder's spelling on that server (rust-analyzer answers nothing for a
//   document outside its folder's spelling); answers and diagnostics go back
//   under the session's spelling of each folder.
// - workspace/symbol asks the session root's server and every other live server
//   the session has used, and merges the answers, kept to the session's folders
//   (see visible: each folder would answer once); other workspace-wide requests
//   go to the session root's server.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { freemem, totalmem, userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES, askNpm, gitRoot, sweepCopies } from './languages.mjs';
import { processes, sameProcess, tree } from './processes.mjs';
import { docKey, endpoint, frame, readFrames } from './rpc.mjs';

// Machine-wide, across sessions and languages. The cap stops a server only when
// MAX_SERVERS checkouts used more recently (the one starting included) need
// one, so no active work loses its navigation (lead's ruling).
const MAX_SERVERS = Number(process.env.LSP_KIT_MAX_SERVERS) || 6;
// Eight sessions' own servers once took ~24 GB and the machine hit its commit
// limit. A server's memory is its process tree's (processes.mjs): rust-analyzer's
// proc-macro servers and cargo check commit memory on its behalf, and end with it.
// One rust-analyzer serving five checkouts of a large repo used 6.7 GB.
const MAX_MEMORY = Number(process.env.LSP_KIT_MAX_MEMORY_MB) * 2 ** 20 || totalmem() / 4;
// The servers' own limit can't see the rest of the machine: a dozen agent
// worktrees' servers beside the agents themselves drove free memory low enough
// for Claude Code's low-memory reaper to kill background agents. Starting a
// server is never refused for it; only idle ones stop. A fixed floor would be
// crossed all the time on a small machine, and on macOS, whose free memory
// leaves out cached and inactive pages: the default is an eighth of the
// machine's memory (8 GB of 64). LSP_KIT_MIN_FREE_MB=0 turns it off; a value
// that isn't a number leaves the default, as the other settings do.
const minFreeMb = process.env.LSP_KIT_MIN_FREE_MB?.trim() ? Number(process.env.LSP_KIT_MIN_FREE_MB) : NaN;
const MIN_FREE = Number.isFinite(minFreeMb) ? minFreeMb * 2 ** 20 : totalmem() / 8;
const MEMORY_LOG_CHANGE = 0.1; // a server's memory is logged again once it moves this much
const size = (bytes) => (bytes < 2 ** 30 ? `${Math.round(bytes / 2 ** 20)} MB` : `${(bytes / 2 ** 30).toFixed(1)} GB`);
const IDLE_MS = Number(process.env.LSP_KIT_IDLE_MS) || 5 * 60 * 1000;
// The reaper's interval. A quarter of IDLE_MS (when shorter than a minute)
// leaves a server room to be past one tick unused, so stoppable, before it
// stops for being idle.
const TICK_MS = Math.min(IDLE_MS / 4, 60 * 1000);
const STOP_KILL_MS = 5000; // a stopping server that hasn't exited by then is killed
const STDERR_LINE = 300; // a server's stderr line is logged up to this many characters
const WATCHED_FILES = 'workspace/didChangeWatchedFiles';
const FILE_CHANGE = { Created: 1, Changed: 2, Deleted: 3 };
const CONTENT_MODIFIED = -32801;
const SERVER_CANCELLED = -32802;
const METHOD_NOT_FOUND = -32601;
const RETRY_MS = 500;
const RETRY_WINDOW_MS = 55 * 1000; // under Claude Code's 60 s request timeout
const DID_OPEN = 'textDocument/didOpen';
const DID_CHANGE = 'textDocument/didChange';
const DID_CLOSE = 'textDocument/didClose';
const PUBLISH = 'textDocument/publishDiagnostics';
const FOLDERS_CHANGED = 'workspace/didChangeWorkspaceFolders';

const { dir, path: PIPE, log: LOG } = endpoint();
const servers = new Map(); // share key -> live server
const running = new Set(); // every server whose process hasn't closed, stopping ones included
const sessions = new Set();
const pending = new Map(); // manager request id -> { id, session, clientId, server, msg, since }
let serverCount = 0;
let stops = 0; // servers stopped or restarted so far (see reap)
let sessionCount = 0;
let ids = 0;

// ---- log, endpoint ------------------------------------------------------------

// Every line goes to the log file and to every session's proxy, which writes it
// to its stderr (Claude Code's LSP log).
function log(line, only) {
	const text = `lsp-kit: ${line}`;
	logFile(text);
	for (const s of only ? [only] : sessions) toSession(s, { jsonrpc: '2.0', method: 'lsp-kit/log', params: { line: text } });
}
const logFile = (text) => appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`);
// LSP_KIT_TRACE=1 logs every message's direction, server, method/id and error.
const trace = process.env.LSP_KIT_TRACE
	? (dir, no, msg) =>
			appendFileSync(LOG, `trace ${dir}#${no} ${msg.method ?? ''} ${msg.id ?? ''} ${docUri(msg.params) ?? ''} ${msg.error ? JSON.stringify(msg.error) : ''}\n`)
	: () => {};

process.on('uncaughtException', (e) => {
	logFile(`lsp-kit: manager crashed: ${e.stack}`);
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
	log(`manager pid ${process.pid} on ${PIPE} (cap ${MAX_SERVERS} servers, memory limit ${size(MAX_MEMORY)}, free memory floor ${MIN_FREE ? size(MIN_FREE) : 'off'}, idle stop ${IDLE_MS / 1000} s)`);
	askNpm().then((npm) => log(npm.dir ? `npm's global folder: ${npm.dir}` : npm.error));
	sweep().catch((e) => log(`leftover servers not swept: ${e.message}`));
	sweepCopies();
	setInterval(reap, TICK_MS);
});

// ---- leftover servers -----------------------------------------------------------

// A server's processes can outlive its manager. On Windows its own servers
// can't: libuv puts each child spawned without `detached` in a job object that
// kills it when the manager exits (Node child_process docs, options.detached),
// but "*their* subprocesses are not" in it (libuv src/win/process.c):
// rust-analyzer's proc-macro servers and cargo check. Elsewhere a server hung
// past its manager's crash never reads the end of its input.
// So each manager records each process in its servers' trees in the data dir
// (at each server start and measurement, until the process is gone), and the
// next manager to start stops the recorded processes of managers that are
// gone, with their descendants.
// - A manager is gone when its pipe doesn't answer with its id (see `gone`).
//   That needs no clock: a start time read back from `ps` moves with a clock
//   step, and would make a live manager look gone.
// - A process is lsp-kit's only by its pid AND creation time, both from one
//   listing: a process that reused the pid, or one lsp-kit didn't start
//   (another editor's rust-analyzer), is never touched. A marker in each
//   server's environment can't be read back on Windows (no documented API
//   reads another process's environment: RTL_USER_PROCESS_PARAMETERS documents
//   only ImagePathName and CommandLine), and a marker argument breaks servers
//   that reject unknown ones.
// - A server's own folder (a language's env hook, see startServer) is recorded
//   before its spawn and removed when it closes; the sweep removes those of a
//   gone manager after stopping its processes.
const RECORDS = `lsp-kit-servers-${userInfo().username}-`;
const SERVER_DIRS = 'lsp-kit-tmp-'; // short: LuaLS's socket path inside must fit 107 bytes (languages.mjs)
const ID = randomUUID();
const RECORD = join(dir, `${RECORDS}${ID}.json`);
const RECORD_ID = 'lsp-kit/record-id'; // another manager's liveness probe (see gone), answered with ID
const owned = new Map(); // pid -> { pid, created, lang, root, server (its server's pid) }, while it lives
const serverDirs = new Set(); // the live servers' own folders
let saved = '';

// Lists the processes and records every running server's tree; resolves to the listing.
function record() {
	return processes().then((list) => {
		for (const [pid, p] of owned) if (!sameProcess(list, p)) owned.delete(pid);
		for (const s of [...running].filter((s) => list.has(s.child?.pid))) {
			s.procs = tree(list, s.child.pid);
			for (const { pid, created } of s.procs) owned.set(pid, { pid, created, lang: s.lang.name, root: label(s), server: s.child.pid });
		}
		saveRecord();
		return list;
	});
}

// A write that fails (Windows refuses a rename while another process reads the
// file) is retried by the next record, never fatal to the manager.
function saveRecord() {
	const text = owned.size || serverDirs.size ? JSON.stringify({ id: ID, pipe: PIPE, pid: process.pid, processes: [...owned.values()], dirs: [...serverDirs] }) : '';
	if (text === saved) return;
	try {
		if (!text) rmSync(RECORD, { force: true });
		else {
			writeFileSync(`${RECORD}.tmp`, text);
			renameSync(`${RECORD}.tmp`, RECORD);
		}
		saved = text;
	} catch (e) {
		log(`servers not recorded (retried at the next measurement): ${e.message}`);
	}
}

// A record's manager runs only if the manager answering on the record's pipe
// has the record's id. A manager restarted on the same pipe answers with its
// own id, so its predecessor's record is swept. Of two managers that raced
// past a stale Unix socket, only the one whose socket file the path names
// answers; the other's record is swept and its servers stopped, while its
// sessions stay connected to it and it restarts their servers on their next
// request. A pipe that doesn't exist is gone; one that doesn't answer in
// PROBE_MS, or closes without answering, isn't known gone.
const PROBE_MS = 5000;
const gone = (rec) =>
	new Promise((resolve) => {
		const probe = connect(rec.pipe);
		const done = (isGone) => (probe.destroy(), resolve(isGone));
		probe.setTimeout(PROBE_MS, () => done(false));
		probe.once('connect', () => probe.write(frame({ jsonrpc: '2.0', id: 1, method: RECORD_ID })));
		probe.once('error', (e) => done(e.code === 'ENOENT' || e.code === 'ECONNREFUSED'));
		probe.once('close', () => done(false));
		// A pipe has one listener, so any frame but the answer to this probe (an
		// older manager's rejection, say) comes from a manager that isn't the record's.
		readFrames(probe, (msg) => done(msg.id !== 1 || msg.result?.id !== rec.id));
	});

// The process list is read after every pipe check, so a slow probe can't leave
// the kills matching a stale list.
async function sweep() {
	const records = [];
	for (const file of readdirSync(dir).filter((f) => f.startsWith(RECORDS) && f.endsWith('.json') && join(dir, f) !== RECORD)) {
		try {
			const rec = JSON.parse(readFileSync(join(dir, file), 'utf8'));
			if (typeof rec.id !== 'string' || typeof rec.pipe !== 'string' || !Array.isArray(rec.processes)) throw new Error('not a server record');
			records.push({ file, rec });
		} catch (e) {
			log(`server record ${file} unreadable, left in place: ${e.message}`);
		}
	}
	const dead = (await Promise.all(records.map(async (r) => ((await gone(r.rec)) ? r : null)))).filter(Boolean);
	if (!dead.length) return;
	const list = await processes();
	for (const { file, rec } of dead) {
		const left = new Map(); // server pid -> { lang, root, pids }
		for (const p of rec.processes.filter((p) => sameProcess(list, p))) {
			if (!left.has(p.server)) left.set(p.server, { lang: p.lang, root: p.root, pids: new Set() });
			for (const q of tree(list, p.pid)) left.get(p.server).pids.add(q.pid);
		}
		for (const [server, { lang, root, pids }] of left) {
			for (const pid of pids) {
				try {
					process.kill(pid);
				} catch {} // exited meanwhile
			}
			log(`stopped what was left of a ${lang} server for ${root} (server pid ${server}): pids ${[...pids].join(', ')}; its manager pid ${rec.pid} is gone`);
		}
		// Only a server folder in the data dir: a record is a file anyone can write.
		const dirs = (rec.dirs ?? []).filter((d) => typeof d === 'string' && basename(d).startsWith(SERVER_DIRS) && join(dir, basename(d)) === d);
		if (!dirs.map(removeServerDir).every(Boolean)) continue;
		try {
			rmSync(join(dir, file), { force: true });
		} catch (e) {
			log(`server record ${file} not removed: ${e.message}`);
		}
	}
}

// A folder that can't be removed yet (a process still holds a file in it)
// stays recorded: this manager's for the sweep after it is gone, a gone
// manager's for the next sweep. False when it stays.
function removeServerDir(d) {
	try {
		rmSync(d, { recursive: true, force: true });
	} catch (e) {
		log(`server folder ${d} not removed: ${e.message}`);
		return false;
	}
	if (serverDirs.delete(d)) saveRecord();
	return true;
}

// ---- servers ------------------------------------------------------------------

const label = (server) => [...server.folders.values()].map((f) => f.root).join(', ');
const workspaceFolder = (path) => ({ uri: pathToFileURL(path).href, name: basename(path) || path });
// The folders the server is told: every one, or for a language that reads them
// only at initialize (`foldersAtStart`, languages.mjs) those inside no other.
const inside = (outer, f) => under(outer.key, f.key) !== null;
const toldOf = (server) => {
	const all = [...server.folders.values()];
	return server.lang.foldersAtStart ? all.filter((f) => !all.some((o) => o !== f && inside(o, f))) : all;
};

// `folders` (objects of newFolder) are the server's; `start` is how it starts (languages.mjs).
function startServer(lang, init, shareKey, folders, start) {
	const server = { lang, init, start, key: shareKey, no: ++serverCount, folders: new Map(), roots: new Map(), peak: 0, docs: new Map(), requests: new Set(), lastUsed: Date.now(), waiting: new Map(), queue: [], ready: false };
	for (const f of folders) addFolder(server, f);
	server.settings = settingsOf(server);
	server.told = toldOf(server);
	servers.set(shareKey, server);
	running.add(server);
	// A start that prepares first (a copy, languages.mjs) spawns once it is done.
	server.initialized = start.prepare ? start.prepare.then(() => launch(server), (e) => ((server.startError = e.message), serverClosed(server))) : launch(server);
	return server;
}

// The process spawned and asked to initialize: its answer, once it comes.
function launch(server) {
	const { lang, init, start } = server;
	if (server.stopped) return serverClosed(server); // stopped while it prepared
	try {
		if (start.error) throw new Error(start.error);
		const { command, args } = start;
		// cwd stays the manager's (the home directory): on Windows a process's cwd
		// can't be deleted, which would block removing the worktree. Servers take
		// their root from rootUri. windowsHide: the manager has no console, so
		// without it each server would get a visible console window of its own.
		// A language's env hook (languages.mjs) gets a folder of the server's own.
		if (lang.env) {
			server.ownDir = join(dir, `${SERVER_DIRS}${ID.slice(0, 8)}-${server.no}`);
			mkdirSync(server.ownDir, { recursive: true });
			serverDirs.add(server.ownDir);
			saveRecord();
		}
		server.child = spawn(command, args, { stdio: 'pipe', windowsHide: true, env: { ...process.env, ...lang.env?.(server.ownDir) } });
		server.child.on('error', (e) => (server.startError = e.message));
		server.child.stdin.on('error', () => {}); // a write racing the child's exit; 'close' cleans up
		server.child.on('close', (code) => serverClosed(server, code));
		readFrames(server.child.stdout, (msg) => {
			try {
				fromServer(server, msg);
			} catch (e) {
				log(`${lang.name} server #${server.no}: dropped ${msg?.method ?? `the answer to ${msg?.id}`}: ${e.message}`);
			}
		});
		// Its stderr (rust-analyzer's panics) goes to the log file only, each line cut short.
		createInterface({ input: server.child.stderr, crlfDelay: Infinity }).on('line', (line) =>
			logFile(`lsp-kit: ${lang.name} server #${server.no} stderr: ${line.slice(0, STDERR_LINE)}`)
		);
		if (server.child.pid) record().catch((e) => log(`${lang.name} server #${server.no} not recorded: ${e.message}`));
	} catch (e) {
		server.startError = e.message;
		setImmediate(() => serverClosed(server));
	}
	log(`${lang.name} server #${server.no} for ${label(server)} (${servers.size} live, pid ${server.child?.pid})`);
	if (start.note) log(`${lang.name} server #${server.no}: ${start.note}`);

	const params = structuredClone(init ?? {});
	params.processId = process.pid; // LSP 3.17: the server exits if this process dies
	params.rootUri = pathToFileURL(server.told[0].root).href;
	params.rootPath = server.told[0].root;
	params.workspaceFolders = server.told.map((f) => workspaceFolder(f.root));
	params.capabilities ??= {};
	params.capabilities.workspace ??= {};
	params.capabilities.workspace.didChangeWatchedFiles = { dynamicRegistration: true };
	params.capabilities.workspace.diagnostics = { refreshSupport: true }; // see pullDiagnostics
	// A shared server hears folder changes, and pulls its settings (see configure).
	if (lang.shared) Object.assign(params.capabilities.workspace, { workspaceFolders: true, configuration: true });
	params.initializationOptions = server.settings;
	return request(server, 'initialize', params, true).then((result) => {
		if (server.closed) return;
		server.pullsDiagnostics = !!result?.capabilities?.diagnosticProvider; // see pullDiagnostics
		write(server, { jsonrpc: '2.0', method: 'initialized', params: {} });
		server.ready = true;
		for (const msg of server.queue.splice(0)) write(server, msg);
		return result;
	});
}

// The process is gone: its sessions' requests fail with the reason. A server
// that exits unasked after answering a request restarts with its folders; else
// the next request for one of its checkouts starts a new server. One that never
// answered isn't restarted: a server that dies on start would loop.
function serverClosed(server, code) {
	server.closed = true;
	running.delete(server);
	const crashed = !server.stopped && server.answered && servers.get(server.key) === server;
	drop(server);
	if (server.ownDir) removeServerDir(server.ownDir);
	server.exitMessage = `lsp-kit: ${server.lang.name} server #${server.no} for ${label(server)} ${server.startError ? `could not start: ${server.startError}` : `exited (code ${code})`}`;
	for (const entry of server.requests) settle(entry, { error: { code: -32603, message: server.exitMessage } });
	for (const resolve of server.waiting.values()) resolve(null);
	log(server.exitMessage.replace(/^lsp-kit: /, ''));
	if (crashed) restart(server, 'it exited unasked');
	else if (!server.stopped) server.folders.forEach(forget);
}

// No new message reaches a stopping or closed server (LSP 3.17: nothing but
// `exit` after `shutdown`).
function drop(server) {
	if (servers.get(server.key) === server) servers.delete(server.key);
}

// The folder is no session's any more.
function forget(folder) {
	folder.watcher?.close();
	for (const s of sessions) s.uses.delete(folder);
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
	if (server.ready) write(server, msg);
	else server.queue.push(msg);
}

// Use, for the idle stop and the cap: a session's request or document in the folder.
const use = (folder) => (folder.lastUsed = folder.server.lastUsed = Date.now());

function request(server, method, params, now = false) {
	const id = `kit:${++ids}`;
	const msg = { jsonrpc: '2.0', id, method, params };
	if (now) write(server, msg);
	else send(server, msg);
	return new Promise((resolve) => server.waiting.set(id, (reply) => resolve(reply?.result)));
}

// LSP 3.17: `shutdown`, then `exit` once it is answered. One still running
// after STOP_KILL_MS is killed.
function stopServer(server, why) {
	if (server.stopped) return;
	halt(server, why);
	server.folders.forEach(forget);
}
function halt(server, why) {
	stops++;
	drop(server);
	log(`stopping ${server.lang.name} server #${server.no} for ${label(server)} (pid ${server.child?.pid}${server.memory ? `, ${size(server.memory)}` : ''}): ${why}`);
	setTimeout(() => server.child?.kill(), STOP_KILL_MS).unref();
	server.stopped = request(server, 'shutdown', null).then(() => write(server, { jsonrpc: '2.0', method: 'exit', params: null }));
}

// A new process takes over the server's live folders, documents and sessions.
function restart(server, why) {
	if (!server.closed) halt(server, why);
	const folders = [...server.folders.values()];
	const resend = server.requests.size ? `, resending ${server.requests.size} in flight` : '';
	log(`restarting ${server.lang.name} server #${server.no} with its ${folders.length} live folder${folders.length > 1 ? 's' : ''}${resend}: ${why}`);
	const next = startServer(server.lang, server.init, server.key, folders, server.start);
	for (const [key, doc] of server.docs) syncFromDisk(next, key, doc.uri, doc.version, doc.holders, doc.folder);
	// A planned restart resends what was in flight (a crash settled it with the
	// reason): the first answer settles it, a later one finds nothing pending.
	for (const entry of server.requests) {
		entry.server = next;
		next.requests.add(entry);
		send(next, entry.msg);
	}
	server.requests.clear();
}

const busy = (server) => server.requests.size > 0 || server.waiting.size > 0;
// No rule stops a server in use. Used within the last tick counts: under
// pressure from outside the servers, the floor would otherwise stop a server
// between two steps of a session's lookup, restart it for the next and stop it
// again (rust-analyzer re-indexing each time). A folder is in use the same way.
const inUse = (server) => busy(server) || Date.now() - server.lastUsed < TICK_MS;
const folderInUse = (folder) => busy(folder.server) || Date.now() - folder.lastUsed < TICK_MS;

// One stopping rule for the cap, the memory limit and the free memory floor:
// while `isOver()`, the least recently used server not in use stops. For the
// memory limit (`lasting`) only what frees memory for good counts: a
// per-checkout server stops, a shared one that dropped folders restarts, and a
// shared one whose folders are all live stays. False when none is left (the cap
// or limit is then exceeded and logged).
function stopLeastRecent(isOver, why, lasting = false) {
	const idle = [...servers.values()].filter((s) => !inUse(s) && (!lasting || !s.lang.shared || s.folders.size < s.peak)).sort((a, b) => a.lastUsed - b.lastUsed);
	while (isOver() && idle.length) {
		const s = idle.shift();
		if (lasting && s.lang.shared) restart(s, why);
		else stopServer(s, why);
	}
	return !isOver();
}

function makeRoom() {
	if (!stopLeastRecent(() => servers.size >= MAX_SERVERS, `room for another under the cap of ${MAX_SERVERS} servers`))
		log(`every live server is in use: ${servers.size + 1} exceed the cap of ${MAX_SERVERS}`);
}

// On the reaper tick: every server's process tree recorded (see sweep) and its
// memory measured, logged when it moved MEMORY_LOG_CHANGE; then stopLeastRecent
// (lasting) while the total exceeds MAX_MEMORY. A per-checkout server that alone
// exceeds the limit is no exception: it can't fit beside any other, and a leak
// that size is what the limit is for. It stops whenever it is not in use, after
// any idle server used less recently, and the log says so once, loudly. A
// shared server whose folders are all live serves them all: stopping it would
// free nothing the next request doesn't take back.
// A measurement still running when the next tick comes (a slow process listing)
// skips that tick's: two would race to record and to stop servers.
let measuring = false;
function measure() {
	if (!servers.size || measuring) return;
	measuring = true;
	record().then(
		(list) => {
			for (const s of [...servers.values()].filter((s) => list.has(s.child?.pid))) {
				s.memory = s.procs.reduce((n, p) => n + p.bytes, 0);
				if (s.logged === undefined || Math.abs(s.memory - s.logged) >= MEMORY_LOG_CHANGE * s.logged) {
					s.logged = s.memory;
					log(`${s.lang.name} server #${s.no} (pid ${s.child.pid}, ${s.procs.length} process${s.procs.length > 1 ? 'es' : ''}) uses ${size(s.memory)}`);
				}
				if (s.memory > MAX_MEMORY && !s.overAlone) {
					s.overAlone = true;
					log(`${s.lang.name} server #${s.no} ALONE uses ${size(s.memory)}, over the memory limit of ${size(MAX_MEMORY)}${s.lang.shared ? '' : ': it stops whenever it is not in use'} (LSP_KIT_MAX_MEMORY_MB sets the limit)`);
				}
			}
			const total = () => [...servers.values()].reduce((n, s) => n + (s.memory ?? 0), 0);
			if (!stopLeastRecent(() => total() > MAX_MEMORY, `over the memory limit of ${size(MAX_MEMORY)}`, true))
				log(`every server left is in use or serves only live folders: their ${size(total())} exceed the memory limit of ${size(MAX_MEMORY)}`);
		},
		(e) => log(`memory not measured, so its limit wasn't applied and its servers not recorded this time: ${e.message}`)
	).finally(() => (measuring = false));
}

// The idle check runs from the manager's start (listening) on and counts every
// connection the server has accepted, not only sessions. The net docs give no
// timing for 'connection' ("emitted when a new connection is made"); it is an
// I/O callback of the event loop's poll phase, and since Node 20 (libuv 1.45)
// timers run after the poll phase in each iteration, and once before the loop
// starts (https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick).
// So a check that fell due while the start blocked the loop runs before the
// proxy that started the manager is accepted (that proxy's requests failed),
// and a check can fall between a proxy's connection and its hello (the message
// that makes it a session). server.close keeps accepted connections, so that
// proxy was served by a manager no longer listening, whose open pipe instance
// on Windows kept a new manager from listening: the next sessions found none.
// getConnections counts accepted sockets until they close
// (https://nodejs.org/api/net.html#servergetconnectionscallback).
//
// A folder leaving frees no memory (rust-analyzer, TypeScript 7 and
// svelte-language-server, measured; TypeScript even keeps answering its
// symbols). So a server not in use that dropped folders restarts with its live
// ones once fewer than half its peak remain (or over the memory limit, see measure).
//
// The free memory floor stops at most one server per tick, counting this tick's
// other stops: a stopped server's memory is freed only as its processes exit,
// so the next tick's reading is the first to show it, and stopping until this
// one's reading cleared the floor would stop every idle server at once.
function reap() {
	const before = stops;
	for (const s of [...servers.values()]) {
		for (const f of [...s.folders.values()]) {
			if (!existsSync(f.root)) removeFolder(f, 'its directory is gone');
			else if (!folderInUse(f) && Date.now() - f.lastUsed > IDLE_MS) removeFolder(f, `unused for ${IDLE_MS / 1000} s`);
		}
		const live = s.folders.size;
		if (!s.stopped && !inUse(s) && live < s.peak / 2) restart(s, `${live} of its peak ${s.peak} folders left`);
	}
	const free = freemem();
	stopLeastRecent(() => stops === before && free < MIN_FREE, `the machine has ${size(free)} free, under the floor of ${size(MIN_FREE)}`);
	measure();
	// Unlisten first: a proxy that connects from now on starts a new manager.
	listener.getConnections((e, connections) => connections === 0 && !running.size && listener.close(() => process.exit(0)));
}

// One key per checkout, however a client spells it (drive-letter case, 8.3
// short names, subst drives, junctions, symlinks): realpathSync.native is the
// true path (Node fs docs: realpath(3); libuv uv_fs_realpath:
// GetFinalPathNameByHandleW on Windows). Only the key is canonical: a folder is
// spelled as the session that added it spells it (its own root's for its
// session root, else the first request's).
const keyOf = (root) => realpathSync.native(root);

// The session's folder for a checkout root in the session's spelling, on the
// server its language runs for it: the one holding it, else the one its
// server binary shares (started if none runs). The share key: language, the
// client's own initializationOptions (the language's part derives from the
// folders), and for a shared language the binary (identity), else the
// checkout. The binary is resolved once per join (rustup reads the
// checkout's rust-toolchain.toml). Counts as use.
function folderFor(session, root) {
	const key = keyOf(root);
	if (key === session.rootKey) root = session.root;
	const { lang } = session;
	const prefix = `${session.language}\n${session.options}\n`;
	let server = [...servers.values()].find((s) => s.key.startsWith(prefix) && s.folders.has(key));
	if (!server) {
		let start;
		try {
			start = lang.server(root);
		} catch (e) {
			start = { error: e.message };
		}
		const shareKey = prefix + (lang.shared && !start.error ? (start.identity ?? start.command) : key);
		server = servers.get(shareKey);
		if (server) addFolder(server, newFolder(lang, key, root), start.note);
		else {
			makeRoom();
			server = startServer(lang, session.init, shareKey, [newFolder(lang, key, root)], start);
		}
	}
	const folder = server.folders.get(key);
	session.uses.set(folder, root);
	use(folder);
	return folder;
}

// A checkout's folder on a server: its spelling there, its own settings
// (languages.mjs), its use and its watcher.
const newFolder = (lang, key, root) => ({ key, root, lastUsed: Date.now(), settings: lang.settings?.(root) });

// The folder joins the server; a running one hears it, and the log the
// checkout's `note` (languages.mjs).
function addFolder(server, folder, note) {
	folder.server = server;
	server.folders.set(folder.key, folder);
	server.roots.set(folder.key, folder.root);
	server.peak = Math.max(server.peak, server.folders.size);
	folder.watcher ??= watchFolder(folder);
	if (!server.initialized) return; // the initialize params carry it
	log(`${server.lang.name} server #${server.no} adds ${folder.root} (${server.folders.size} folders)${note ? `: ${note}` : ''}`);
	// A language that reads its folders only at initialize restarts for one outside them.
	if (!server.lang.foldersAtStart) send(server, { jsonrpc: '2.0', method: FOLDERS_CHANGED, params: { event: { added: [workspaceFolder(folder.root)], removed: [] } } });
	else if (!server.told.some((t) => inside(t, folder))) return restart(server, `${folder.root} is outside the folders it was started with`);
	configure(server);
}

// The folder leaves its server, with its documents; the last one stops it.
function removeFolder(folder, why) {
	const server = folder.server;
	if (server.folders.size === 1) return stopServer(server, why);
	server.folders.delete(folder.key);
	forget(folder);
	for (const [key, doc] of server.docs) {
		if (doc.folder !== folder) continue;
		server.docs.delete(key);
		send(server, { jsonrpc: '2.0', method: DID_CLOSE, params: { textDocument: { uri: doc.uri } } });
	}
	log(`${server.lang.name} server #${server.no} drops ${folder.root} (${server.folders.size} of its peak ${server.peak} folders left): ${why}`);
	if (!server.lang.foldersAtStart) send(server, { jsonrpc: '2.0', method: FOLDERS_CHANGED, params: { event: { added: [], removed: [workspaceFolder(folder.root)] } } });
	configure(server);
}

// The server's settings: its folders' own (languages.mjs) joined, arrays
// concatenated, under the client's initializationOptions. rust-analyzer ignores
// folder changes while its linkedProjects is set, so a server with a settings
// section hears every change (didChangeConfiguration; rust-analyzer then pulls
// workspace/configuration, answered from SERVER_REQUESTS).
function settingsOf(server) {
	const joined = {};
	for (const f of server.folders.values()) for (const [k, v] of Object.entries(f.settings ?? {})) joined[k] = [...(joined[k] ?? []), ...v];
	return { ...joined, ...server.init?.initializationOptions };
}
function configure(server) {
	server.settings = settingsOf(server);
	if (server.lang.section) send(server, { jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { [server.lang.section]: server.settings } } });
}

// ---- spelling -----------------------------------------------------------------

// `path` relative to `root`, or null when it isn't under it.
const under = (root, path) => {
	const rel = relative(root, path);
	return rel.startsWith('..') || isAbsolute(rel) ? null : rel;
};
// `uri` respelled by the first [from, to] pair whose `from` holds it.
function respell(uri, pairs) {
	if (!uri.startsWith('file:')) return uri;
	for (const [from, to] of pairs) {
		const rel = under(from, fileURLToPath(uri));
		if (rel !== null) return from === to ? uri : pathToFileURL(join(to, rel)).href;
	}
	return uri;
}
// Every file URI in an answer (values and keys, e.g. WorkspaceEdit.changes)
// respelled from the server's spelling of each folder to the session's.
function respellAll(value, server, session) {
	const pairs = [...server.roots].map(([key, root]) => [root, session.uses.get(server.folders.get(key)) ?? root]).sort((a, b) => b[0].length - a[0].length);
	if (pairs.every(([from, to]) => from === to)) return value;
	const walk = (v) =>
		typeof v === 'string'
			? respell(v, pairs)
			: Array.isArray(v)
				? v.map(walk)
				: v && typeof v === 'object'
					? Object.fromEntries(Object.entries(v).map(([k, x]) => [respell(k, pairs), walk(x)]))
					: v;
	return walk(value);
}
// The key of the most specific folder the server was ever given that holds
// `uri`, else null.
function ownerOf(server, uri) {
	if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
	const path = fileURLToPath(uri);
	let owner = null;
	for (const [key, root] of server.roots) if (under(root, path) !== null && root.length > (server.roots.get(owner)?.length ?? -1)) owner = key;
	return owner;
}
// The symbols of a workspace/symbol answer the session may see: in a folder it
// uses, or outside every folder the server was given (a toolchain's sources).
// A folder the server dropped is no one's, and TypeScript 7 still answers for it.
const visible = (server, session, symbols) =>
	symbols.filter((s) => {
		const key = ownerOf(server, s.location?.uri);
		return key === null || session.uses.has(server.folders.get(key));
	});
const withDocUri = (params, uri) =>
	params.textDocument ? { ...params, textDocument: { ...params.textDocument, uri } } : { ...params, item: { ...params.item, uri } };

// ---- sessions -> servers ------------------------------------------------------

// A connection becomes a session with its proxy's hello; until then it is
// registered nowhere and gets no log lines (the pipe's default ACL lets other
// local users connect).
function attach(socket) {
	const session = { no: ++sessionCount, socket, uses: new Map(), pending: new Map() }; // uses: folder -> the session's spelling of its root
	socket.on('error', () => {}); // 'close' follows
	socket.on('close', () => detach(session));
	// A message the manager can't handle (malformed, or its checkout vanished
	// mid-way) is answered with the reason; no client input stops the manager.
	readFrames(socket, (msg) => {
		try {
			if (session.lang) fromSession(session, msg);
			else hello(session, msg);
		} catch (e) {
			log(`session #${session.no}: ${msg?.method ?? 'response'} failed: ${e.message}`);
			if (msg?.method && msg.id != null) toSession(session, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `lsp-kit: ${e.message}` } });
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
// Any other first message ends the connection with the reason.
function hello(session, msg) {
	if (msg?.method === RECORD_ID) {
		toSession(session, { jsonrpc: '2.0', id: msg.id, result: { id: ID } });
		return void session.socket.end();
	}
	const { language, cwd, pid, initialize } = (msg?.method === 'lsp-kit/hello' && msg.params) || {};
	if (!Object.hasOwn(LANGUAGES, language)) {
		toSession(session, { jsonrpc: '2.0', method: 'lsp-kit/log', params: { line: `lsp-kit: rejected: the first message must be a hello for one of ${Object.keys(LANGUAGES).join(', ')}` } });
		session.socket.end();
		return;
	}
	Object.assign(session, { language, lang: LANGUAGES[language], cwd: String(cwd) });
	sessions.add(session);
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
	if (msg.method === 'initialize') {
		begin(session, msg.params);
		const home = folderFor(session, session.root).server;
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
	// A server parses any document it gets as its own language (svelte-language-server
	// parses a .ts as Svelte, and its references go wrong after).
	const path = uri?.startsWith('file:') && fileURLToPath(uri);
	if (path && !Object.hasOwn(session.lang.extensionToLanguage, extname(path).toLowerCase())) throw new Error(`${path} is no ${session.lang.name} file`);
	if (!uri) {
		const home = folderFor(session, session.root);
		if (msg.method === 'workspace/symbol') {
			// The session root's server (started if stopped) plus every other live one it has used.
			const asked = new Set([...session.uses.keys()].map((f) => f.server).filter((s) => s === home.server || s.ready));
			for (const f of session.uses.keys()) if (asked.has(f.server)) use(f);
			Promise.all([...asked].map((s) => request(s, msg.method, msg.params).then((a) => respellAll(visible(s, session, a ?? []), s, session))))
				.then((answers) => answer(session, msg.id, home.server, answers.flat()))
				.catch((e) => toSession(session, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `lsp-kit: ${e.message}` } }));
		} else if (msg.method === 'workspace/didChangeConfiguration') for (const s of new Set([...session.uses.keys()].map((f) => f.server))) send(s, msg);
		else route(session, home, msg);
		return;
	}
	// The git toplevel owning the file, in the session's spelling, else the session root.
	const root = (path && gitRoot(dirname(path))) || session.root;
	// Closing never starts a server: a stopped one has nothing open.
	const folder = msg.method === DID_CLOSE ? [...session.uses.keys()].find((f) => f.key === keyOf(root)) : folderFor(session, root);
	if (!folder) return;
	const { server } = folder;
	const serverUri = respell(uri, [[root, folder.root]]);
	if (serverUri !== uri) msg = { ...msg, params: withDocUri(msg.params, serverUri) };
	const key = docKey(serverUri);
	const doc = server.docs.get(key);
	const version = msg.params.textDocument?.version ?? 0;
	if (msg.method === DID_CLOSE) return closeDoc(server, key, session);
	if (!doc && msg.method === DID_OPEN) {
		server.docs.set(key, { uri: serverUri, folder, holders: new Set([session]), owner: session, version });
		return sendDoc(server, msg);
	}
	if (msg.method === DID_CHANGE && doc?.owner === session) {
		doc.version = version;
		return sendDoc(server, msg);
	}
	const sync = msg.method === DID_OPEN || msg.method === DID_CHANGE;
	// The server's copy isn't this session's (or the server lacks the document):
	// load it from disk, which already holds any edit the session reports.
	if (sync || !doc) syncFromDisk(server, key, serverUri, version, new Set([session]), folder);
	if (!sync) route(session, folder, msg);
}

// The server's copy of the document set to the file on disk, `holders` among
// its holders. An open document gets the whole text as one change (LSP 3.17
// TextDocumentContentChangeEvent without a range), not a close and reopen:
// after a quick close and reopen, LuaLS's last diagnostics for the file came
// without its warnings in one of four test/shared.mjs runs.
function syncFromDisk(server, key, uri, version, holders, folder) {
	let text;
	try {
		text = readFileSync(fileURLToPath(uri), 'utf8');
	} catch {
		return;
	}
	const doc = server.docs.get(key);
	if (!doc) {
		server.docs.set(key, { uri, folder, holders, owner: null, version });
		return sendDoc(server, { jsonrpc: '2.0', method: DID_OPEN, params: { textDocument: { uri, languageId: server.lang.extensionToLanguage[extname(uri)], version, text } } });
	}
	holders.forEach((h) => doc.holders.add(h));
	doc.owner = null;
	sendDoc(server, { jsonrpc: '2.0', method: DID_CHANGE, params: { textDocument: { uri: doc.uri, version: ++doc.version }, contentChanges: [{ text }] } });
}

// A didOpen or didChange to the server, then the document's diagnostics pulled.
function sendDoc(server, msg) {
	send(server, msg);
	const key = docKey(docUri(msg.params));
	server.initialized.then(() => pullDiagnostics(server, key));
}

// LSP 3.17 "Pull Diagnostics" (textDocument_pullDiagnostics): a server whose
// initialize result advertises `diagnosticProvider` may answer only
// `textDocument/diagnostic` (TypeScript 7 does), but Claude Code's client takes
// only pushed `publishDiagnostics`. So the manager pulls each open document
// after every change it sends and on `workspace/diagnostic/refresh`, and pushes
// the report on.
// - The pulled set doesn't replace the pushed one. The spec defines no such
//   replacement, and its DiagnosticOptions.identifier names a separate set
//   "managed by the client". rust-analyzer pushes its cargo-check errors
//   (borrow errors among them) and answers pulls with its own analysis. A
//   document's last pushed and last pulled sets are kept apart and published as
//   their union.
// - One pull per document is in flight. A change supersedes it: the request is
//   cancelled and its late answer ignored, because TypeScript 7 answers
//   concurrent pulls out of order. A refresh during a pull pulls once more after it.
// - `ServerCancelled` re-pulls unless its data says not to (the spec's default
//   is `retriggerRequest: true`). MethodNotFound (svelte-language-server
//   advertises pulls it doesn't answer) ends pulling from that server, even
//   when it answers a superseded pull.
// - Pulls never count as use, so a server whose refreshes follow file churn
//   still stops when idle.
function pullDiagnostics(server, key, refresh = false) {
	const doc = server.docs.get(key);
	if (!server.pullsDiagnostics || server.stopped || !doc) return;
	if (doc.pulling && refresh) return void (doc.repull = true);
	if (doc.pulling) write(server, { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: doc.pulling } });
	const id = (doc.pulling = `kit:${++ids}`);
	doc.repull = false;
	server.waiting.set(id, (reply) => {
		if (reply?.error?.code === METHOD_NOT_FOUND && server.pullsDiagnostics) {
			server.pullsDiagnostics = false;
			return log(`${server.lang.name} server #${server.no} advertises pull diagnostics but doesn't answer them: no more pulls`);
		}
		if (!reply || server.docs.get(key) !== doc || doc.pulling !== id) return; // server gone, document closed, or superseded
		doc.pulling = null;
		const { error, result } = reply;
		if (error?.code === SERVER_CANCELLED && error.data?.retriggerRequest !== false) return void setTimeout(() => pullDiagnostics(server, key, true), RETRY_MS);
		if (result?.kind === 'full') publishDoc(server, doc, { pulled: result.items });
		if (doc.repull) pullDiagnostics(server, key);
	});
	send(server, { jsonrpc: '2.0', id, method: 'textDocument/diagnostic', params: { textDocument: { uri: doc.uri } } });
}

// The document's pushed or pulled set replaced; their union goes to its holders.
function publishDoc(server, doc, sets) {
	Object.assign(doc, sets);
	const params = { uri: doc.uri, diagnostics: [...(doc.pushed ?? []), ...(doc.pulled ?? [])] };
	for (const s of doc.holders) toSession(s, respellAll({ jsonrpc: '2.0', method: PUBLISH, params }, server, s));
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

// A session request (or notification) to the server of one of its folders.
function route(session, folder, msg) {
	const { server } = folder;
	if (msg.id == null) return send(server, msg);
	const entry = { id: `kit:${++ids}`, session, clientId: msg.id, server, since: Date.now() };
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
	const { server, session, msg } = entry;
	const rewrite = server.lang.results?.[msg.method];
	const result = respellAll(rewrite && reply.result ? rewrite(reply.result) : reply.result, server, session);
	toSession(session, reply.error ? { jsonrpc: '2.0', id: entry.clientId, error: reply.error } : { jsonrpc: '2.0', id: entry.clientId, result });
}

// ---- servers -> sessions ------------------------------------------------------

// Server->client requests, answered here: no default (null) is wrong for these.
const SERVER_REQUESTS = {
	// One null per item ("can't provide"), but the server's own settings section (see configure).
	'workspace/configuration': (params, server) => params.items.map((i) => (server.lang.section && i.section === server.lang.section ? server.settings : null)),
	'workspace/workspaceFolders': (params, server) => server.told.map((f) => workspaceFolder(f.root)),
	'workspace/diagnostic/refresh': (params, server) => void [...server.docs.keys()].forEach((key) => pullDiagnostics(server, key, true))
};

function fromServer(server, msg) {
	trace('<=', server.no, msg);
	if (msg.id != null && !msg.method) {
		const resolve = server.waiting.get(msg.id);
		if (resolve) {
			server.waiting.delete(msg.id);
			resolve(msg);
			return;
		}
		// A restart resent the request: only its current server answers it.
		const entry = pending.get(msg.id);
		if (entry?.server !== server) return;
		// rust-analyzer answers ContentModified while it (re)loads the workspace; the
		// spec leaves the retry to the client, which Claude Code doesn't do.
		if (msg.error?.code === CONTENT_MODIFIED && Date.now() - entry.since < RETRY_WINDOW_MS) {
			entry.retrying = true;
			setTimeout(() => {
				if (pending.get(entry.id) !== entry) return;
				entry.retrying = false;
				send(entry.server, entry.msg);
			}, RETRY_MS);
			return;
		}
		server.answered = true; // see serverClosed
		settle(entry, msg);
		return;
	}
	if (msg.id != null) return write(server, { jsonrpc: '2.0', id: msg.id, result: SERVER_REQUESTS[msg.method]?.(msg.params, server) ?? null });
	// Progress tokens are the manager's (it answered window/workDoneProgress/create).
	if (msg.method === '$/progress') return;
	const doc = msg.method === PUBLISH && server.docs.get(docKey(msg.params.uri));
	if (doc) return publishDoc(server, doc, { pushed: msg.params.diagnostics });
	// A push for a file not open goes to the sessions using its folder; anything
	// else to every session using the server.
	const owner = msg.method === PUBLISH ? ownerOf(server, msg.params.uri) : null;
	const reaches = (s) => (owner !== null ? s.uses.has(server.folders.get(owner)) : [...s.uses.keys()].some((f) => f.server === server));
	for (const s of [...sessions].filter(reaches)) toSession(s, respellAll(msg, server, s));
}

// ---- file watching ------------------------------------------------------------

// One watcher per folder, from its join until it is forgotten: the changes go
// to whichever server holds the folder now (a restart moves it) once it is ready.
function watchFolder(folder) {
	const watchExts = new Set(folder.server.lang.watch);
	let changed = new Map();
	let timer = null;
	try {
		const watcher = watch(folder.root, { recursive: true }, (event, filename) => {
			if (!filename) return;
			const parts = filename.split(/[\\/]/);
			if (parts.some((d) => d === 'node_modules' || d === 'target' || (d.startsWith('.') && d !== '.svelte-kit'))) return;
			const path = join(folder.root, filename);
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
				const { server } = folder;
				if (servers.get(server.key) === server) send(server, { jsonrpc: '2.0', method: WATCHED_FILES, params: { changes } });
			}, 50);
		});
		return watcher.on('error', (e) => log(`watching ${folder.root} failed: ${e.message}`));
	} catch (e) {
		log(`watching ${folder.root} failed: ${e.message}`);
	}
}
