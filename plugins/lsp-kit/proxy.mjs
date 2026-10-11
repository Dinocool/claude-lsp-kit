// The per-session connector Claude Code starts for each language:
//   node proxy.mjs <language>   (a key of LANGUAGES)
// It forwards the session's LSP traffic to the machine-wide manager
// (manager.mjs), which runs ONE server per checkout for every session. If no
// manager answers on the endpoint (rpc.mjs), the proxy starts one (launch.mjs)
// and connects; the pipe admits one listener, so racing proxies end up on one
// manager. If the manager exits, requests it hadn't answered fail with that
// reason, and the next message reconnects (starting a new manager) and replays
// the session's `initialize` params in the hello. A manager that can't be
// started or reached fails each request with the reason: there is no
// per-session fallback. Each response is shaped for the client before it is
// written out (shape.mjs).
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from './languages.mjs';
import { endpoint, frame, readFrames } from './rpc.mjs';
import { shape } from './shape.mjs';

if (!LANGUAGES[process.argv[2]]) throw new Error(`lsp-kit: unknown language "${process.argv[2]}"`);
const CONNECT_MS = 10 * 1000; // a manager it started gets this long to listen
const { path, log } = endpoint();
const launcher = fileURLToPath(new URL('./launch.mjs', import.meta.url)); // starts the manager with no live parent
let init = null; // the client's initialize params, replayed to every new manager
let shutdownReceived = false;
let link = null; // the manager connection: a promise of the socket while connecting or connected
const unanswered = new Map(); // client request id -> method, sent to the current manager
// Documents this session has open (didOpen minus didClose). A server pushes
// diagnostics for whole projects, and the shared manager runs servers for every
// session's worktree: pushes for documents this session never opened are other
// sessions' churn, which the client renders into this session's context all
// the same (measured 2026-10-11: 92% of a session's diagnostic bytes were
// never-opened files in other agents' worktrees). Forward a
// publishDiagnostics only for an open document; LSPKIT_RAW=1 passes every
// push through, the same switch as shape.mjs.
const openDocs = new Set();
const raw = process.env.LSPKIT_RAW === '1';

const toClient = (msg) => process.stdout.write(frame(msg));
const fail = (id, message) => toClient({ jsonrpc: '2.0', id, error: { code: -32603, message: `lsp-kit: ${message}` } });
const exit = () => process.exit(shutdownReceived ? 0 : 1); // LSP 3.17: 0 only after `shutdown`

readFrames(process.stdin, (msg) => {
	if (msg.method === 'exit') exit();
	if (msg.method === 'shutdown') shutdownReceived = true;
	if (msg.method === 'initialize') init = msg.params;
	if (msg.method === 'textDocument/didOpen') openDocs.add(msg.params?.textDocument?.uri);
	if (msg.method === 'textDocument/didClose') openDocs.delete(msg.params?.textDocument?.uri);
	const request = msg.method && msg.id != null;
	link ??= open().catch((e) => {
		link = null;
		throw e;
	});
	link.then(
		(socket) => (request && unanswered.set(msg.id, msg.method), socket.write(frame(msg))),
		(e) => (request ? fail(msg.id, e.message) : process.stderr.write(`lsp-kit: ${msg.method ?? 'response'} dropped: ${e.message}\n`))
	);
});
process.stdin.on('end', exit);

async function open() {
	let socket = await tryConnect();
	if (!socket) {
		spawn(process.execPath, [launcher], { stdio: 'ignore', windowsHide: true, cwd: homedir() }).unref();
		for (const end = Date.now() + CONNECT_MS; !socket && Date.now() < end; ) {
			await new Promise((r) => setTimeout(r, 100));
			socket = await tryConnect();
		}
	}
	if (!socket) throw new Error(`no manager answered on ${path} (its log: ${log})`);
	socket.on('error', () => {}); // 'close' follows
	socket.on('close', () => {
		link = null;
		for (const id of unanswered.keys()) fail(id, 'the manager exited before answering; the next request starts a new one');
		unanswered.clear();
	});
	readFrames(socket, (msg) => {
		if (msg.method === 'lsp-kit/log') return void process.stderr.write(msg.params.line + '\n');
		if (!raw && msg.method === 'textDocument/publishDiagnostics' && !openDocs.has(msg.params?.uri)) return;
		if (msg.id != null && !msg.method) {
			// Shape the answer before the client renders it (shape.mjs); the method
			// comes from the request this answers.
			const method = unanswered.get(msg.id);
			unanswered.delete(msg.id);
			if (method && !msg.error) msg.result = shape(method, msg.result);
		}
		toClient(msg);
	});
	socket.write(frame({ jsonrpc: '2.0', method: 'lsp-kit/hello', params: { language: process.argv[2], cwd: process.cwd(), pid: process.pid, initialize: init } }));
	return socket;
}

const tryConnect = () =>
	new Promise((resolve) => {
		const socket = connect(path);
		socket.once('connect', () => resolve(socket));
		socket.once('error', () => resolve(null));
	});
