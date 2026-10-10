// Sessions sharing one manager (Lua), in a throwaway repo under <dir>: two
// sessions on one checkout share ONE server; a document stays open on it until
// the last session closes it or disconnects; diagnostics reach every session
// with the document open, each in its own spelling of the checkout; a killed
// manager is replaced on the next request; proxies starting at the same
// instant end up on one manager; a connection without a valid hello is turned
// away; the manager survives a tree kill of the proxy that started it.
// Usage: node test/shared.mjs <scratchDir>   (needs lua-language-server and git)
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipePath, readFrames } from '../plugins/lsp-kit/rpc.mjs';
import { alive, check, finish, killManager, log, managerProcesses, privatePipe, startProxy, wait } from './client.mjs';

rmSync(process.argv[2], { recursive: true, force: true });
mkdirSync(join(process.argv[2], 'repo'), { recursive: true });
const base = realpathSync.native(process.argv[2]);
const repo = join(base, 'repo');
// A second spelling of the checkout: a junction (a symlink off Windows), like an
// 8.3 short name or a subst drive.
const link = join(base, 'link');
symlinkSync(repo, link, 'junction');
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
writeFileSync(join(repo, '.luarc.json'), '{"runtime.version":"Lua 5.1"}');
writeFileSync(join(repo, 'a.lua'), 'local function helper(x) return x end\nhelper(1)\nhelper(2)\nlocal unused = 1\n');
writeFileSync(join(repo, 'b.lua'), 'local other = 2\nreturn other\n');
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');

const until = async (cond, ms) => {
	for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await wait(100);
	return cond();
};
const refs = async (client, dir) => {
	const params = { textDocument: { uri: pathToFileURL(join(dir, 'a.lua')).href }, position: { line: 0, character: 16 }, context: { includeDeclaration: true } };
	let r;
	for (let i = 0; i < 40; i++) {
		r = await client.req('textDocument/references', params);
		if (r?.error || r?.length === 3) break;
		await wait(500);
	}
	return r?.error ? `ERROR ${r.error}` : `${r?.length ?? 0} refs in ${[...new Set(r?.map((l) => fileURLToPath(l.uri)))].join(', ')}`;
};
const open = (client, dir, file) => {
	const uri = pathToFileURL(join(dir, file)).href;
	client.open(uri, 'lua', readFileSync(join(dir, file), 'utf8'));
	return uri;
};
const samePath = (uri, path) => fileURLToPath(uri).toLowerCase() === path.toLowerCase();

// ---- two sessions, one checkout, two spellings -----------------------------------
const data = join(base, 'data'); // the manager's log (with every message traced) lands here
const shared = { LSP_KIT_PIPE: privatePipe(), CLAUDE_PLUGIN_DATA: data, LSP_KIT_TRACE: '1' };
const traceLog = join(data, `${shared.LSP_KIT_PIPE}.log`);
const logLines = () => readFileSync(traceLog, 'utf8').split('\n');
// The didClose notifications the manager sent the server for `file`.
const closesSent = (file) => logLines().filter((l) => l.startsWith('trace ->#') && / textDocument\/didClose +\S*\/repo\/(.*) /.exec(l)?.[1] === file).length;
// Every server start the manager logged, whichever session caused it.
const starts = () => logLines().filter((l) => / live, pid /.test(l));
const diagnostics = (client) => {
	const got = new Map(); // path the session spelled -> its latest diagnostics
	client.onNotification = (m) => m.method === 'textDocument/publishDiagnostics' && got.set(m.params.uri, m.params.diagnostics);
	return got;
};

const a = startProxy('lua', repo, { ...shared, name: 'a' });
const b = startProxy('lua', link, { ...shared, name: 'b' });
const aDiags = diagnostics(a);
const bDiags = diagnostics(b);
await a.initialize(repo);
await b.initialize(link);
check(a.manager && a.manager === b.manager, `both sessions joined one manager (pid ${a.manager})`);
check((await refs(a, repo)).startsWith('3 refs'), 'session a answers');
const bRefs = await refs(b, link);
check(bRefs === `3 refs in ${join(link, 'a.lua')}`, `session b answers, in its own spelling: ${bRefs}`);
check(starts().length === 1, `one server for both: ${starts().length} start line(s)`);

const aUri = open(a, repo, 'a.lua');
const bUri = open(b, link, 'a.lua');
const unused = (diags) => diags?.some((d) => d.code === 'unused-local');
const aGot = await until(() => [...aDiags].some(([uri, d]) => samePath(uri, join(repo, 'a.lua')) && unused(d)), 30000);
check(aGot, `diagnostics reach session a under ${repo}: ${JSON.stringify([...aDiags.keys()])}`);
const bGot = await until(() => unused(bDiags.get(bUri)), 30000);
check(bGot, `diagnostics reach session b as ${bUri}: ${JSON.stringify([...bDiags.keys()])}`);
check(![...bDiags.keys()].some((uri) => samePath(uri, join(repo, 'a.lua'))), "session b never sees a's spelling");

b.notify('textDocument/didClose', { textDocument: { uri: bUri } });
await wait(500);
check(closesSent('a.lua') === 0, "b's didClose does not close the document a still has open");
check((await refs(a, repo)).startsWith('3 refs'), 'session a still answers');

// ---- a session's proxy is killed ----------------------------------------------------
open(b, link, 'b.lua');
open(b, link, 'a.lua');
await wait(500);
const serverPid = a.pidFor(repo);
b.proxy.kill();
await b.exited;
check(await until(() => closesSent('b.lua') === 1, 5000), "killing b's proxy closes the document only b had open");
check(closesSent('a.lua') === 0, 'and keeps the one a still has open');
check((await refs(a, repo)).startsWith('3 refs') && alive(serverPid) && starts().length === 1, `the server (pid ${serverPid}) stays for session a`);
a.notify('textDocument/didClose', { textDocument: { uri: aUri } });
check(await until(() => closesSent('a.lua') === 1, 5000), "a's didClose, the last holder's, closes the document");

// ---- connections that don't open with a valid hello -------------------------------
// Each gets the reason and is closed, sees no other log line, and the manager keeps serving.
const raw = (body) =>
	new Promise((resolve) => {
		const socket = connect(pipePath(shared.LSP_KIT_PIPE, data));
		const lines = [];
		readFrames(socket, (m) => lines.push(m.params?.line ?? JSON.stringify(m)));
		socket.on('error', () => {});
		socket.on('close', () => resolve(lines));
		socket.on('connect', () => socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
		setTimeout(() => socket.destroy(), 5000);
	});
for (const [what, body] of [
	['an unknown language', JSON.stringify({ jsonrpc: '2.0', method: 'lsp-kit/hello', params: { language: '__proto__' } })],
	['no hello params', JSON.stringify({ jsonrpc: '2.0', method: 'lsp-kit/hello' })],
	['a null message', 'null'],
	['a request instead of a hello', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })]
]) {
	const lines = await raw(body);
	check(lines.length === 1 && /rejected: the first message must be a hello/.test(lines[0]), `${what}: the connection gets only the reason and is closed (${JSON.stringify(lines)})`);
}
check(alive(a.manager) && (await refs(a, repo)).startsWith('3 refs'), 'the manager keeps serving session a');
// A connection that hasn't said hello hears nothing, not even a server's crash and restart.
const silent = raw('');
const crashed = a.pidFor(repo);
process.kill(crashed);
await wait(1500);
check((await refs(a, repo)).startsWith('3 refs') && a.pidFor(repo) !== crashed, `session a answers after its server (pid ${crashed}) was killed`);
check((await silent).length === 0, 'a connection without a hello got no log line');

// ---- the manager is killed ---------------------------------------------------------
const c = startProxy('lua', link, { ...shared, name: 'c' });
await c.initialize(link);
const oldManager = a.manager;
killManager(oldManager);
await until(() => !alive(oldManager), 5000);
await wait(500);
check((await refs(a, repo)).startsWith('3 refs'), "session a's next request answers");
check((await refs(c, link)) === `3 refs in ${join(link, 'a.lua')}`, "session c's next request answers, in its own spelling");
check(a.manager !== oldManager && a.manager === c.manager, `both on one new manager (pid ${a.manager}, was ${oldManager})`);
await a.close();
await c.close();
killManager(a.manager);

// ---- proxies starting at the same instant ---------------------------------------
const race = { LSP_KIT_PIPE: privatePipe() };
const racers = [1, 2, 3, 4].map((n) => startProxy('lua', repo, { ...race, name: `racer${n}` }));
await Promise.all(racers.map((r) => r.initialize(repo)));
const pids = new Set(racers.map((r) => r.manager));
check(pids.size === 1, `four proxies started together joined one manager: ${[...pids].join(', ')}`);
await wait(1000);
const running = managerProcesses();
check(running.length === 1 && pids.has(running[0]), `and one manager process runs: ${running.join(', ')}`);
log(`managers of this test: ${running.join(', ')}`);
await Promise.all(racers.map((r) => r.close()));

// ---- a tree kill of the proxy that started the manager (Windows) ---------------------
// Claude Code may end a session's process tree; the manager every session shares must survive it.
if (process.platform === 'win32') {
	const tree = { LSP_KIT_PIPE: privatePipe() };
	const starter = startProxy('lua', repo, { ...tree, name: 'starter' });
	await starter.initialize(repo);
	const other = startProxy('lua', repo, { ...tree, name: 'other' });
	await other.initialize(repo);
	execSync(`taskkill /T /F /PID ${starter.proxy.pid}`, { stdio: 'pipe' });
	await starter.exited;
	await wait(500);
	check(alive(starter.manager), `taskkill /T /F of the proxy that started it leaves the manager (pid ${starter.manager}) running`);
	check((await refs(other, repo)).startsWith('3 refs') && other.manager === starter.manager, 'and serving the other session');
	await other.close();
}
finish();
