// Diagnostics gating (proxy.mjs): a non-empty publishDiagnostics for a file of
// a language the kit serves reaches the client only while the session has it
// open (didOpen minus didClose, matched by file path however the uri is
// spelled); a push for any other file (project config such as tsconfig.json)
// or an empty one (a clear) always passes; LSPKIT_RAW=1 forwards every push.
// Drives real proxies against a fake manager on a private pipe, so no language
// server is needed — the fake manager pushes the notifications and the test
// watches what the proxy lets through.
// Usage: node test/diagnostics.mjs <scratchDir>
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
// Real paths under the scratch dir, so the uri spellings the proxy parses are
// ones a client would send.
const uriOf = (file) => pathToFileURL(join(dir, file)).href;
const pushDiags = (uri, messages) =>
	push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: messages.map((message) => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message })) } });
const opened = uriOf('opened.ts');
client.open(opened, 'typescript', 'const a: number = 1\n'); // also connects the proxy (lazy link)
check(await until(() => connects >= 1), 'first proxy connected to the fake manager');
await wait(150);
pushDiags(opened, ['a diagnostic']);
pushDiags(uriOf('other-worktree.mjs'), ['another session churn']);
await wait(400);
check(JSON.stringify(got) === JSON.stringify([opened]), `an open document's diagnostics forwarded, an unopened served one dropped (got ${JSON.stringify(got)})`);

// Project config is no language the kit serves: its errors (TypeScript 7's
// tsconfig ones say why answers come back empty) reach the session unopened.
pushDiags(uriOf('tsconfig.json'), ["'baseUrl' has been removed"]);
pushDiags(uriOf('unopened.ts'), ['a diagnostic for a file this session never opened']);
await wait(400);
check(JSON.stringify(got) === JSON.stringify([opened, uriOf('tsconfig.json')]), `an unopened tsconfig.json's non-empty push reaches the client, an unopened .ts file's does not (got ${JSON.stringify(got)})`);

// After didClose the uri is no longer open, but the server's empty follow-up
// push is the clear that removes the file's last errors: it must pass, while a
// non-empty push for the closed document still doesn't.
client.notify('textDocument/didClose', { textDocument: { uri: opened } });
await wait(150);
pushDiags(opened, []);
pushDiags(opened, ['a late diagnostic']);
await wait(400);
check(JSON.stringify(got) === JSON.stringify([opened, uriOf('tsconfig.json'), opened]), `after didClose the empty clear reaches the client and a non-empty push does not (got ${JSON.stringify(got)})`);

// A push spelled differently from the didOpen (drive-letter case, %3A) is the
// same document and passes. The fold is a Windows behaviour; elsewhere it
// would be two different paths.
if (process.platform === 'win32') {
	const cased = uriOf('cased.ts');
	const respelled = cased.replace(/^file:\/\/\/(\w):/i, (_, drive) => `file:///${drive.toLowerCase()}%3A`);
	client.open(cased, 'typescript', 'const c = 3\n');
	await wait(150);
	pushDiags(respelled, ['same document, other spelling']);
	await wait(400);
	check(got.at(-1) === respelled, `a push whose uri differs from the didOpen only in drive-letter case or %3A encoding reaches the client (got ${JSON.stringify(got)})`);
} else log('skipped on this platform: matching a drive-letter case or %3A spelling is a Windows behaviour');
client.notify('exit', null);

const rawGot = [];
pushes.length = 0; // a late-connecting proxy is replayed the push history; the raw section starts clean
const rawClient = startProxy('typescript', dir, { name: 'raw', LSP_KIT_PIPE: pipe, LSPKIT_RAW: '1' });
rawClient.onNotification = (m) => m.method === 'textDocument/publishDiagnostics' && rawGot.push(m.params.uri);
rawClient.notify('initialized', {}); // the proxy connects to the manager on its first frame
check(await until(() => connects >= 2), 'raw proxy connected to the fake manager');
pushDiags(uriOf('never-opened.mjs'), ['raw passes everything']);
await wait(400);
check(rawGot.length === 1, 'LSPKIT_RAW=1 forwards a never-opened document (kill switch works)');
rawClient.notify('exit', null);

await wait(150);
log(`manager connections: ${conns.length}`);
conns.forEach((s) => s.end());
manager.close();
finish();
