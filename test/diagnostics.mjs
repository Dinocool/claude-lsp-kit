// Diagnostics gating (proxy.mjs): a publishDiagnostics reaches the client for
// a document the session opened (didOpen minus didClose, matched by file path
// however the uri is spelled) or when its diagnostics array is empty — a clear
// always passes; LSPKIT_RAW=1 forwards every push. Drives real proxies against
// a fake manager on a private pipe, so no language server is needed — the fake
// manager pushes the notifications and the test watches what the proxy lets
// through.
// Usage: node test/diagnostics.mjs <scratchDir>
import { createServer } from 'node:net';
import { frame, pipePath, readFrames } from '../plugins/lsp-kit/rpc.mjs';
import { check, finish, log, scratch, startProxy, wait } from './client.mjs';

const dir = scratch(process.argv[2] ?? 'diagnostics-test');
const pipe = `lsp-kit-test-diag-${process.pid}`;
const pushes = []; // { uri, diagnostics: [...] } the fake manager has sent
const conns = [];
let connects = 0; // every connection ever made (the proxy connects on its first frame)
const manager = createServer((socket) => {
	conns.push(socket);
	connects++;
	socket.on('close', () => conns.splice(conns.indexOf(socket), 1));
	socket.on('error', () => {});
	readFrames(socket, (m) => log(`fake manager: client sent ${m.method ?? 'response'}`)); // the proxy's hello and the client's notifications
	for (const p of pushes) socket.write(frame(p));
});
manager.on('error', (e) => log(`fake manager: server error ${e.code}`));
manager.listen(pipePath(pipe, process.env.CLAUDE_PLUGIN_DATA));

const push = (msg) => {
	pushes.push(msg);
	conns.forEach((s) => s.write(frame(msg)));
};
const until = async (fn, ms = 3000) => {
	for (const end = Date.now() + ms; !fn(); ) {
		if (Date.now() > end) return false;
		await wait(50);
	}
	return true;
};

// One session's notifications, with time for the proxy to apply them between
// the pushes they gate (each wait is far above a local round trip).
const got = [];
const client = startProxy('typescript', dir, { name: 'gated', LSP_KIT_PIPE: pipe });
client.onNotification = (m) => m.method === 'textDocument/publishDiagnostics' && got.push(m.params.uri);
client.open('file:///opened.ts', 'typescript', 'const a: number = 1\n'); // also connects the proxy (lazy link)
check(await until(() => connects >= 1), 'first proxy connected to the fake manager');
await wait(150);
push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///opened.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: 'a diagnostic' }] } });
push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///other-worktree.mjs', diagnostics: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } }, message: 'another session churn' }] } });
await wait(400);
check(JSON.stringify(got) === JSON.stringify(['file:///opened.ts']), `open document's diagnostics forwarded, unopened dropped (got ${JSON.stringify(got)})`);

// After didClose the uri is no longer open, but the server's empty follow-up
// push is the clear that removes the file's last errors: it must pass, while a
// non-empty push for the closed document still doesn't.
client.notify('textDocument/didClose', { textDocument: { uri: 'file:///opened.ts' } });
await wait(150);
push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///opened.ts', diagnostics: [] } });
push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///opened.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: 'a late diagnostic' }] } });
await wait(400);
check(JSON.stringify(got) === JSON.stringify(['file:///opened.ts', 'file:///opened.ts']), `after didClose the empty clear reaches the client and a non-empty push does not (got ${JSON.stringify(got)})`);

// A push spelled differently from the didOpen (drive-letter case, %3A) is the
// same document and passes. The fold is a Windows behaviour; elsewhere it
// would be two different paths.
if (process.platform === 'win32') {
	client.open('file:///D:/cased.ts', 'typescript', 'const c = 3\n');
	await wait(150);
	push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///d%3A/cased.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: 'same document, other spelling' }] } });
	await wait(400);
	check(got.at(-1) === 'file:///d%3A/cased.ts', `a push whose uri differs from the didOpen only in drive-letter case or %3A encoding reaches the client (got ${JSON.stringify(got)})`);
} else log('skipped on this platform: matching a drive-letter case or %3A spelling is a Windows behaviour');
client.notify('exit', null);

const rawGot = [];
pushes.length = 0; // a late-connecting proxy is replayed the push history; the raw section starts clean
const rawClient = startProxy('typescript', dir, { name: 'raw', LSP_KIT_PIPE: pipe, LSPKIT_RAW: '1' });
rawClient.onNotification = (m) => m.method === 'textDocument/publishDiagnostics' && rawGot.push(m.params.uri);
rawClient.notify('initialized', {}); // the proxy connects to the manager on its first frame
check(await until(() => connects >= 2), 'raw proxy connected to the fake manager');
push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///never-opened.mjs', diagnostics: [{ message: 'raw passes everything' }] } });
await wait(400);
check(rawGot.length === 1, 'LSPKIT_RAW=1 forwards a never-opened document (kill switch works)');
rawClient.notify('exit', null);

await wait(150);
log(`manager connections: ${conns.length}`);
conns.forEach((s) => s.end());
manager.close();
finish();
