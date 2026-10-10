// Lifecycle of the lsp-kit proxy's servers (Lua), in a throwaway repo under <dir>:
// a crashed worktree server and a crashed session-root server both come back on
// the next request in the same proxy; a worktree can be removed while its server
// runs; the session root's server stops when idle and restarts on demand; the
// client's exit and the end of stdin each stop every server the proxy started.
// Usage: node test/lifecycle.mjs <scratchDir>   (needs lua-language-server and git)
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { alive, check, finish, log, startProxy, wait } from './client.mjs';

const base = process.argv[2];
const repo = join(base, 'repo');
rmSync(base, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
writeFileSync(join(repo, '.luarc.json'), '{"runtime.version":"Lua 5.1","workspace.ignoreDir":[".claude"]}');
writeFileSync(join(repo, 'a.lua'), 'local function helper(x) return x end\nhelper(1)\nhelper(2)\n');
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');
sh('git worktree add -q .claude/worktrees/wt');
const wt = join(repo, '.claude', 'worktrees', 'wt');

// References to `helper` (declaration + 2 calls), retried while LuaLS loads the workspace.
const refs = async (client, dir) => {
	const params = { textDocument: { uri: pathToFileURL(join(dir, 'a.lua')).href }, position: { line: 0, character: 16 }, context: { includeDeclaration: true } };
	let r;
	for (let i = 0; i < 40; i++) {
		r = await client.req('textDocument/references', params);
		if (r?.error || r?.length === 3) break;
		await wait(500);
	}
	return r?.error ? `ERROR ${r.error}` : `${r?.length ?? 0} refs`;
};
const until = async (cond, ms) => {
	for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await wait(100);
	return cond();
};

// ---- crashes, worktree removal, client exit -----------------------------------
const a = startProxy('lua', repo);
await a.initialize(repo);
check((await refs(a, repo)) === '3 refs', 'main checkout answers');
check((await refs(a, wt)) === '3 refs', 'worktree answers');

const wtPid = a.pidFor(wt);
process.kill(wtPid);
await wait(1500);
check((await refs(a, wt)) === '3 refs' && a.pidFor(wt) !== wtPid, `worktree answers after its server (pid ${wtPid}) was killed`);

const mainPid = a.pidFor(repo);
process.kill(mainPid);
await wait(1500);
check((await refs(a, repo)) === '3 refs' && a.pidFor(repo) !== mainPid, `main checkout answers after its server (pid ${mainPid}) was killed`);
check(a.proxy.exitCode === null, `the proxy (pid ${a.proxy.pid}) is still running`);

try {
	sh('git worktree remove --force .claude/worktrees/wt');
	check(!existsSync(wt), 'git worktree remove succeeds while its server runs');
} catch (e) {
	check(false, `git worktree remove: ${e.stderr?.toString().trim()}`);
}
check((await refs(a, repo)) === '3 refs', 'main checkout answers after the removal');

const aPids = a.pids();
const aCode = await a.close();
check(aCode === 0, `shutdown + exit: the proxy exits with code 0 (got ${aCode})`);
check(aPids.every((p) => !alive(p)), `shutdown + exit: every server it started has exited (${aPids.join(', ')})`);

// ---- idle stop of the session root's server, end of stdin ----------------------
const b = startProxy('lua', repo, { LSP_KIT_IDLE_MS: '3000' });
await b.initialize(repo);
check((await refs(b, repo)) === '3 refs', 'main checkout answers (3 s idle stop)');
const idlePid = b.pidFor(repo);
const stopped = await until(() => b.stderr.some((l) => l.includes(`stopping Lua server #1 for ${repo}`)) && !alive(idlePid), 15000);
check(stopped, `the main checkout's server (pid ${idlePid}) stops when idle`);
b.notify('textDocument/didClose', { textDocument: { uri: pathToFileURL(join(repo, 'a.lua')).href } });
await wait(500);
check(b.pidFor(repo) === idlePid, 'closing a document does not start a stopped server');
let symbols;
for (let i = 0; i < 40; i++) {
	symbols = await b.req('workspace/symbol', { query: 'helper' });
	if (symbols?.error || symbols?.length) break;
	await wait(500); // empty while LuaLS loads the workspace
}
check(symbols?.some?.((s) => s.name === 'helper'), 'workspaceSymbol starts the stopped server and finds helper');
check((await refs(b, repo)) === '3 refs' && b.pidFor(repo) !== idlePid, 'the next request restarts it with the same answer');

const bPids = b.pids();
b.proxy.stdin.end();
await b.exited;
log('stdin ended: proxy exited');
check(bPids.every((p) => !alive(p)), `end of stdin: every server the proxy started has exited (${bPids.join(', ')})`);

// ---- a server that can't start ------------------------------------------------
const c = startProxy('lua', repo, { PATH: '' });
const init = await c.initialize(repo);
check(/could not start: .*ENOENT/.test(init?.error), `initialize answers the start error (${init?.error})`);
check(/could not start: .*ENOENT/.test(await refs(c, repo)), 'a request answers the next start error');
check(c.proxy.exitCode === null, 'the proxy is still running');
check((await c.close()) === 0, 'shutdown + exit');
finish();
