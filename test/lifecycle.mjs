// Lifecycle of the lsp-kit manager's servers (Lua), in a throwaway repo under <dir>:
// a crashed worktree server and a crashed session-root server both come back on
// the next request; a worktree can be removed while its server runs; killing
// the manager takes every server with it; the machine-wide cap stops the least
// recently used server across sessions, never one with a request in flight;
// the session root's server stops when idle and restarts on demand, and a
// manager left with no session and no server exits.
// Usage: node test/lifecycle.mjs <scratchDir>   (needs lua-language-server and git)
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { alive, check, finish, killManager, log, privatePipe, startProxy, wait } from './client.mjs';

const base = process.argv[2];
rmSync(base, { recursive: true, force: true });
mkdirSync(join(base, 'repo'), { recursive: true });
const repo = realpathSync.native(join(base, 'repo')); // the spelling the manager logs
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
writeFileSync(join(repo, '.luarc.json'), '{"runtime.version":"Lua 5.1","workspace.ignoreDir":[".claude"]}');
writeFileSync(join(repo, 'a.lua'), 'local function helper(x) return x end\nhelper(1)\nhelper(2)\n');
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');
sh('git worktree add -q .claude/worktrees/wt');
const wt = join(repo, '.claude', 'worktrees', 'wt');

// References to `helper` (declaration + 2 calls), retried while LuaLS loads the workspace.
const refsParams = (dir) => ({ textDocument: { uri: pathToFileURL(join(dir, 'a.lua')).href }, position: { line: 0, character: 16 }, context: { includeDeclaration: true } });
const refs = async (client, dir) => {
	let r;
	for (let i = 0; i < 40; i++) {
		r = await client.req('textDocument/references', refsParams(dir));
		if (r?.error || r?.length === 3) break;
		await wait(500);
	}
	return r?.error ? `ERROR ${r.error}` : `${r?.length ?? 0} refs`;
};
const until = async (cond, ms) => {
	for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await wait(100);
	return cond();
};
const starts = (client) => client.stderr.filter((l) => / live, pid /.test(l));

// ---- crashes, worktree removal, manager exit ---------------------------------
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
check(a.proxy.exitCode === null && alive(a.manager), `the proxy (pid ${a.proxy.pid}) and the manager (pid ${a.manager}) are still running`);

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
killManager(a.manager);
check(await until(() => aPids.every((p) => !alive(p)), 5000), `killing the manager (pid ${a.manager}): every server it started exits (${aPids.join(', ')})`);

// ---- the machine-wide cap -----------------------------------------------------
// Two sessions on one manager with a cap of 3 use four checkouts: the fourth
// start stops the least recently used server, another session's.
const wts = [1, 2, 3].map((n) => (sh(`git worktree add -q .claude/worktrees/wt${n}`), join(repo, '.claude', 'worktrees', `wt${n}`)));
const capped = { LSP_KIT_PIPE: privatePipe(), LSP_KIT_MAX_SERVERS: '3' };
const x = startProxy('lua', repo, { ...capped, name: 'x' });
const y = startProxy('lua', repo, { ...capped, name: 'y' });
await x.initialize(repo);
await y.initialize(repo);
await refs(x, repo);
await refs(x, wts[0]);
await refs(y, wts[1]);
check((await refs(y, wts[2])) === '3 refs', 'a fourth checkout answers with three servers live');
check(y.stderr.some((l) => l.includes(`stopping Lua server #1 for ${repo}`)), "the least recently used server, the other session's main checkout, stopped for it");
const most = Math.max(...starts(y).map((l) => Number(/\((\d+) live/.exec(l)[1])));
check(most <= 3, `never more than 3 live (at most ${most})`);
check((await refs(x, repo)) === '3 refs', 'the stopped checkout answers again, restarted');
await x.close();
await y.close();

// With a cap of 1, a server with a request in flight (queued while it starts)
// is not stopped for the next start: the cap is exceeded and logged.
const one = startProxy('lua', repo, { LSP_KIT_MAX_SERVERS: '1' });
await one.initialize(repo);
await refs(one, repo);
const [first, second] = await Promise.all([wts[0], wts[1]].map((dir) => one.req('textDocument/references', refsParams(dir))));
check(!first?.error && !second?.error, `both requests answer (${JSON.stringify(first?.error ?? second?.error ?? 'ok')})`);
check(!one.stderr.some((l) => l.includes(`stopping Lua server #2 for ${wts[0]}`)), 'the server with a request in flight is not stopped for the next start');
check(one.stderr.some((l) => /every live server has a request in flight: 2 exceed the cap of 1/.test(l)), 'the cap is exceeded and logged');
await one.close();

// ---- idle stop of the session root's server, manager exit ---------------------
const b = startProxy('lua', repo, { LSP_KIT_IDLE_MS: '3000' });
await b.initialize(repo);
check((await refs(b, repo)) === '3 refs', 'main checkout answers (3 s idle stop)');
const idleStop = async () => {
	const pid = b.pidFor(repo);
	const stopped = await until(() => b.stderr.some((l) => l.includes(`stopping Lua server #${starts(b).length} for ${repo}`)) && !alive(pid), 15000);
	check(stopped, `the main checkout's server (pid ${pid}) stops when idle`);
	return pid;
};
const symbolHelper = async () => {
	let r;
	for (let i = 0; i < 40; i++) {
		r = await b.req('workspace/symbol', { query: 'helper' });
		if (r?.error || r?.length) break;
		await wait(500); // empty while LuaLS loads the workspace
	}
	return r?.some?.((s) => s.name === 'helper');
};
const idlePid = await idleStop();
b.notify('textDocument/didClose', { textDocument: { uri: pathToFileURL(join(repo, 'a.lua')).href } });
await wait(500);
check(b.pidFor(repo) === idlePid, 'closing a document does not start a stopped server');
check((await symbolHelper()) && b.pidFor(repo) !== idlePid, 'workspaceSymbol starts the stopped server and finds helper');

await idleStop();
// The client may spell the checkout differently (drive-letter case): still one server.
const otherDrive = join(base, 'repo').replace(/^[a-z]/i, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
check((await refs(b, otherDrive)) === '3 refs', `a request spelled ${otherDrive} restarts it with the same answer`);
const restart = starts(b).at(-1);
check(restart.includes(` for ${repo} (`), `it restarts in the session's own spelling: ${restart}`);
check(await symbolHelper(), 'workspaceSymbol finds helper');
check(starts(b).length === 3, `one server per checkout: ${starts(b).length} starts (the first and two restarts)`);

const bPids = b.pids();
const bManager = b.manager;
b.proxy.stdin.end();
await b.exited;
log('stdin ended: proxy exited');
const gone = await until(() => ![...bPids, bManager].some(alive), 20000);
check(gone, `with no session left, the servers stop when idle and the manager exits (${[...bPids, bManager].join(', ')})`);

// ---- a server that can't start ------------------------------------------------
const c = startProxy('lua', repo, { PATH: '' });
const init = await c.initialize(repo);
check(/could not start: .*ENOENT/.test(init?.error), `initialize answers the start error (${init?.error})`);
check(/could not start: .*ENOENT/.test(await refs(c, repo)), 'a request answers the next start error');
check(c.proxy.exitCode === null, 'the proxy is still running');
check((await c.close()) === 0, 'shutdown + exit');
finish();
