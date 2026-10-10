// The machine-wide memory limit and the sweep of leftover servers, in a
// throwaway repo under <dir>. Under a 1 MB limit the least recently used idle
// Lua server stops first, then the next, while a server with a request in
// flight (test/stub-server.mjs posing as svelte-language-server) never stops;
// a real server's measured memory is plausible. Then the stub's manager is
// killed and the stub's helper process outlives it (the stub too, off
// Windows): the next manager's start stops them, and leaves running a
// look-alike (the same program, orphaned too) that lsp-kit didn't start.
// Usage: node test/memory.mjs <scratchDir>   (needs lua-language-server and git)
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { alive, check, finish, killManager, privatePipe, scratch, startProxy, wait } from './client.mjs';

const base = process.argv[2];
scratch(base);
mkdirSync(join(base, 'repo'), { recursive: true });
const repo = realpathSync.native(join(base, 'repo')); // the spelling the manager logs
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
writeFileSync(join(repo, '.luarc.json'), '{"runtime.version":"Lua 5.1","workspace.ignoreDir":[".claude"]}');
writeFileSync(join(repo, 'a.lua'), 'local function helper(x) return x end\nhelper(1)\nhelper(2)\n');
writeFileSync(join(repo, 'a.svelte'), '<p>stub</p>\n');
// The project's own svelte-language-server comes first (languages.mjs): the stub.
const stub = join(repo, 'node_modules', 'svelte-language-server', 'bin', 'server.js');
mkdirSync(join(stub, '..'), { recursive: true });
writeFileSync(stub, `import(${JSON.stringify(new URL('./stub-server.mjs', import.meta.url).href)});\n`);
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');
sh('git worktree add -q .claude/worktrees/wt');
const wt = join(repo, '.claude', 'worktrees', 'wt');

const until = async (cond, ms) => {
	for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await wait(200);
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
	return r?.error ? `ERROR ${r.error}` : `${r?.length ?? 0} refs`;
};
const bytes = (n, unit) => Number(n) * 2 ** (unit === 'GB' ? 30 : 20);

// ---- the memory limit -----------------------------------------------------------
// The limit is applied on the reaper tick (every IDLE_MS, here 20 s); none of
// the servers has been unused that long by the first tick.
const limited = { LSP_KIT_PIPE: privatePipe(), LSP_KIT_MAX_MEMORY_MB: '1', LSP_KIT_IDLE_MS: '20000', STUB_HELPER: '1' };
const lua = startProxy('lua', repo, { ...limited, name: 'lua' });
await lua.initialize(repo);
check((await refs(lua, repo)) === '3 refs', 'Lua server #1 (the main checkout) answers');
check((await refs(lua, wt)) === '3 refs', 'Lua server #2 (the worktree) answers, used after #1');
const svelte = startProxy('svelte', repo, { ...limited, name: 'svelte' });
await svelte.initialize(repo);
svelte.req('textDocument/hover', { textDocument: { uri: pathToFileURL(join(repo, 'a.svelte')).href }, position: { line: 0, character: 1 } }); // never answered

const memoryStops = () => lua.stderr.map((l) => /stopping (\w+) server #(\d+) .*over the memory limit/.exec(l)).filter(Boolean).map((m) => `${m[1]} #${m[2]}`);
const exceeded = () => lua.stderr.some((l) => /every server left has a request in flight: their .* exceed the memory limit of 1 MB/.test(l));
await until(() => memoryStops().length >= 2 && exceeded(), 45000);
check(memoryStops().join(', ') === 'Lua #1, Lua #2', `over the limit, the least recently used idle server stops first, then the next (${memoryStops().join(', ')})`);
check(exceeded(), 'with only the server with a request in flight left, the limit is exceeded and logged');
check(!lua.stderr.some((l) => /stopping Svelte server/.test(l)), 'the server with a request in flight is never stopped');
const reading = lua.stderr.map((l) => /Lua server #1 \(pid \d+, \d+ process(?:es)?\) uses ([\d.]+) (MB|GB)$/.exec(l)).find(Boolean);
const used = reading && bytes(reading[1], reading[2]);
check(used > 0 && used < totalmem(), `a real server's measured memory is plausible: ${reading?.slice(1).join(' ')} of the machine's ${(totalmem() / 2 ** 30).toFixed(1)} GB`);
check(lua.stderr.some((l) => /Lua server #1 ALONE uses .*, over the memory limit of 1 MB: it stops whenever it has no request in flight/.test(l)), 'a server alone over the limit is named loudly');

// ---- leftover servers -------------------------------------------------------------
// The tick recorded the stub and its helper. Killing their manager kills the
// stub on Windows (its job object), not elsewhere; the helper survives either way.
const data = process.env.CLAUDE_PLUGIN_DATA;
const managerLog = (pipe) => readFileSync(join(data, `${pipe}.log`), 'utf8');
const stubPid = Number(svelte.stderr.map((l) => /Svelte server #\d+ for .* pid (\d+)\)$/.exec(l)?.[1]).find(Boolean));
const helperPid = Number(/Svelte server #\d+ stderr: helper pid (\d+)/.exec(managerLog(limited.LSP_KIT_PIPE))?.[1]);
const record = () => readdirSync(data).filter((f) => f.startsWith('lsp-kit-servers-')).map((f) => readFileSync(join(data, f), 'utf8')).join();
check([stubPid, helperPid].every((pid) => record().includes(`"pid":${pid},`)), `the manager recorded the stub (pid ${stubPid}) and its helper (pid ${helperPid})`);
// A look-alike: the same program, started outside lsp-kit by a parent that has exited.
const lookAlike = Number(
	execFileSync(process.execPath, ['-e', `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(stub)}, '--stdio'], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); console.log(c.pid)`]).toString()
);
killManager(svelte.manager);
await wait(2000);
check(alive(helperPid) && !alive(svelte.manager), `the stub's helper (pid ${helperPid}) outlives its killed manager (pid ${svelte.manager}); the stub ${alive(stubPid) ? 'does too' : "doesn't"}`);

const next = { LSP_KIT_PIPE: privatePipe() };
const later = startProxy('lua', repo, { ...next, name: 'next' });
await later.initialize(repo);
check(await until(() => ![stubPid, helperPid].some(alive), 15000), "the next manager's start stops what was left of the stub");
const swept = /stopped what was left of a Svelte server for (.*) \(server pid (\d+)\): pids ([\d, ]+); its manager pid (\d+) is gone/.exec(managerLog(next.LSP_KIT_PIPE));
check(
	swept?.[1] === repo && Number(swept[2]) === stubPid && swept[3].split(', ').includes(String(helperPid)) && Number(swept[4]) === svelte.manager,
	`it logs the stop with the pids, language and why: ${swept?.[0]}`
);
check(alive(lookAlike), `the look-alike lsp-kit didn't start (pid ${lookAlike}) still runs`);
process.kill(lookAlike);
await later.close();
check(await until(() => ![stubPid, helperPid, lookAlike].some(alive), 5000), 'no stub process is left running');
for (const pid of [stubPid, helperPid].filter(alive)) process.kill(pid); // after a failure above
finish();
