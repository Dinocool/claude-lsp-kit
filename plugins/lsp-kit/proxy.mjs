// The per-session connector Claude Code starts for each language:
//   node proxy.mjs <language>   (a key of LANGUAGES)
// It forwards the session's LSP traffic to the machine-wide manager
// (manager.mjs), which runs ONE server per checkout for every session. If no
// manager answers on the endpoint (rpc.mjs), the proxy starts one detached and
// connects; the pipe admits one listener, so racing proxies end up on one
// manager. If the manager exits, requests it hadn't answered fail with that
// reason, and the next message reconnects (starting a new manager) and replays
// the session's `initialize` params in the hello. A manager that can't be
// started or reached fails each request with the reason: there is no
// per-session fallback.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from './languages.mjs';
import { endpoint, frame, readFrames } from './rpc.mjs';

if (!LANGUAGES[process.argv[2]]) throw new Error(`lsp-kit: unknown language "${process.argv[2]}"`);
const CONNECT_MS = 10 * 1000; // a manager it started gets this long to listen
const { path, log } = endpoint();
const manager = fileURLToPath(new URL('./manager.mjs', import.meta.url));
let init = null; // the client's initialize params, replayed to every new manager
let shutdownReceived = false;
let link = null; // the manager connection: a promise of the socket while connecting or connected
const unanswered = new Set(); // client request ids sent to the current manager

const toClient = (msg) => process.stdout.write(frame(msg));
const fail = (id, message) => toClient({ jsonrpc: '2.0', id, error: { code: -32603, message: `lsp-kit: ${message}` } });
const exit = () => process.exit(shutdownReceived ? 0 : 1); // LSP 3.17: 0 only after `shutdown`

readFrames(process.stdin, (msg) => {
	if (msg.method === 'exit') exit();
	if (msg.method === 'shutdown') shutdownReceived = true;
	if (msg.method === 'initialize') init = msg.params;
	const request = msg.method && msg.id != null;
	link ??= open().catch((e) => {
		link = null;
		throw e;
	});
	link.then(
		(socket) => (request && unanswered.add(msg.id), socket.write(frame(msg))),
		(e) => (request ? fail(msg.id, e.message) : process.stderr.write(`lsp-kit: ${msg.method ?? 'response'} dropped: ${e.message}\n`))
	);
});
process.stdin.on('end', exit);

async function open() {
	let socket = await tryConnect();
	if (!socket) {
		spawn(process.execPath, [manager], { detached: true, stdio: 'ignore', windowsHide: true, cwd: homedir() }).unref();
		for (const end = Date.now() + CONNECT_MS; !socket && Date.now() < end; ) {
			await new Promise((r) => setTimeout(r, 100));
			socket = await tryConnect();
		}
	}
	if (!socket) throw new Error(`no manager answered on ${path} (its log: ${log})`);
	socket.on('error', () => {}); // 'close' follows
	socket.on('close', () => {
		link = null;
		for (const id of unanswered) fail(id, 'the manager exited before answering; the next request starts a new one');
		unanswered.clear();
	});
	readFrames(socket, (msg) => {
		if (msg.method === 'lsp-kit/log') return void process.stderr.write(msg.params.line + '\n');
		if (msg.id != null && !msg.method) unanswered.delete(msg.id);
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
