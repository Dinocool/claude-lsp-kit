// The machine-wide memory limit and the sweep of leftover servers, in a
// throwaway repo under <dir>. Under a 1 MB limit the least recently used idle
// Lua server stops first, then the next, while a server with a request in
// flight (test/stub-server.mjs posing as svelte-language-server) never stops;
// a real server's measured memory is plausible. While the machine's free
// memory is under the floor, one idle server stops per reaper tick, least
// recently used first, never the stub; above it, none. Then the stub's manager is
// killed and the stub's helper process outlives it (the stub too, off
// Windows): the next manager's start stops them. It leaves running a
// look-alike (the same program, orphaned too) that lsp-kit didn't start, even
// with a gone manager's record naming its pid, and the servers of a live
// manager whose record names a gone pid. A record that can't be written is
// logged and the manager goes on serving.
// Usage: node test/memory.mjs <scratchDir>   (needs lua-language-server and git)
import { execFileSync, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { totalmem, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { processes } from '../plugins/lsp-kit/processes.mjs';
import { pipePath } from '../plugins/lsp-kit/rpc.mjs';
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
const RECORDS = `lsp-kit-servers-${userInfo().username}-`; // manager.mjs's record files
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

// ---- the free memory floor --------------------------------------------------------
// A floor of twice the machine's memory keeps free memory under it at every
// reaper tick (every IDLE_MS, here 30 s); the tests' 1 MB floor (client.mjs)
// keeps it above. No memory limit applies here: the default is far above these servers.
const floored = { LSP_KIT_PIPE: privatePipe(), LSP_KIT_MIN_FREE_MB: String((2 * totalmem()) / 2 ** 20), LSP_KIT_IDLE_MS: '30000' };
const under = startProxy('lua', repo, { ...floored, name: 'under' });
const above = startProxy('lua', repo, { LSP_KIT_IDLE_MS: '20000', name: 'above' });
await Promise.all([under.initialize(repo), above.initialize(repo)]);
check((await refs(under, repo)) === '3 refs', 'under the floor: Lua server #1 (the main checkout) answers');
check((await refs(under, wt)) === '3 refs', 'under the floor: Lua server #2 (the worktree) answers, used after #1');
const pinned = startProxy('svelte', repo, { ...floored, name: 'pinned' });
await pinned.initialize(repo);
pinned.req('textDocument/hover', { textDocument: { uri: pathToFileURL(join(repo, 'a.svelte')).href }, position: { line: 0, character: 1 } }); // never answered
check((await refs(above, repo)) === '3 refs', 'above the floor: its Lua server answers');

const floorStops = () => under.stderr.map((l) => /stopping (\w+) server #(\d+) .*: the machine has .* free, under the floor of /.exec(l)).filter(Boolean).map((m) => `${m[1]} #${m[2]}`);
await until(() => floorStops().length >= 1, 60000);
await wait(2000); // well inside the tick
check(floorStops().join(', ') === 'Lua #1', `under the floor, one server stops per tick: the least recently used idle one (${floorStops().join(', ')})`);
// Used again, so the next tick's stop is the floor's, not the idle stop's.
check((await refs(under, wt)) === '3 refs', 'Lua server #2 is used again between the ticks');
await until(() => floorStops().length >= 2, 40000);
check(floorStops().join(', ') === 'Lua #1, Lua #2', `the next tick stops the next one (${floorStops().join(', ')})`);
await wait(32000); // one more tick, with only the server with a request in flight left
check(!under.stderr.some((l) => /stopping Svelte server/.test(l)), 'under the floor, the server with a request in flight is never stopped');
const measured = above.stderr.some((l) => /Lua server #1 \(pid \d+, .*\) uses /.test(l));
check(measured && !above.stderr.some((l) => /under the floor/.test(l)), `above the floor, nothing stops for it (measured on a tick: ${measured})`);
const pinnedPid = pinned.pidFor(repo);
killManager(pinned.manager);
killManager(above.manager);
try {
	process.kill(pinnedPid); // the stub outlives its manager off Windows
} catch {} // gone with it

// ---- leftover servers -------------------------------------------------------------
// The stub and its helper were recorded. Killing their manager kills the stub
// on Windows (its job object), not elsewhere; the helper survives either way.
const data = process.env.CLAUDE_PLUGIN_DATA;
const managerLog = (pipe) => readFileSync(join(data, `${pipe}.log`), 'utf8');
const records = () => readdirSync(data).filter((f) => f.startsWith(RECORDS) && f.endsWith('.json'));
const recordOf = (pipe) => records().find((f) => JSON.parse(readFileSync(join(data, f), 'utf8')).pipe === pipePath(pipe, data));
const stubPid = Number(svelte.stderr.map((l) => /Svelte server #\d+ for .* pid (\d+)\)$/.exec(l)?.[1]).find(Boolean));
const helperPid = Number(/Svelte server #\d+ stderr: helper pid (\d+)/.exec(managerLog(limited.LSP_KIT_PIPE))?.[1]);
const recorded = (pipe, pids) => pids.every((pid) => recordOf(pipe) && readFileSync(join(data, recordOf(pipe)), 'utf8').includes(`"pid":${pid},`));
check(recorded(limited.LSP_KIT_PIPE, [stubPid, helperPid]), `the manager recorded the stub (pid ${stubPid}) and its helper (pid ${helperPid})`);

// A live manager: its pipe answers, so the next manager's sweep leaves its record and servers alone.
const liveEnv = { LSP_KIT_PIPE: privatePipe() };
const live = startProxy('lua', repo, { ...liveEnv, name: 'live' });
await live.initialize(repo);
check((await refs(live, repo)) === '3 refs', 'a live manager serves the main checkout');
const livePid = live.pidFor(repo);
check(await until(() => recorded(liveEnv.LSP_KIT_PIPE, [livePid]), 10000), `it recorded its server (pid ${livePid}) at the start`);
const liveRecord = join(data, recordOf(liveEnv.LSP_KIT_PIPE));

// A look-alike: the same program, started outside lsp-kit by a parent that has
// exited. A forged record of a gone manager names its pid with another start time.
const lookAlike = Number(
	execFileSync(process.execPath, ['-e', `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(stub)}, '--stdio'], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); console.log(c.pid)`]).toString()
);
const lookAlikeStart = (await processes()).get(lookAlike).created;
const forged = { id: 'forged', pipe: pipePath(privatePipe(), data), pid: 1, processes: [{ pid: lookAlike, created: lookAlikeStart + 1, lang: 'Svelte', root: repo, server: lookAlike }] };
writeFileSync(join(data, `${RECORDS}forged.json`), JSON.stringify(forged));

// A record naming the next manager's own pipe under another id: a predecessor's.
const next = { LSP_KIT_PIPE: privatePipe() };
const predecessor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true }).pid;
const predecessorStart = (await processes()).get(predecessor).created;
const samePath = join(data, `${RECORDS}same-path.json`);
const predecessorRecord = { id: 'a-predecessor', pipe: pipePath(next.LSP_KIT_PIPE, data), pid: 1, processes: [{ pid: predecessor, created: predecessorStart, lang: 'Lua', root: repo, server: predecessor }] };
writeFileSync(samePath, JSON.stringify(predecessorRecord));

killManager(svelte.manager);
await wait(2000);
check(alive(helperPid) && !alive(svelte.manager), `the stub's helper (pid ${helperPid}) outlives its killed manager (pid ${svelte.manager}); the stub ${alive(stubPid) ? 'does too' : "doesn't"}`);

const later = startProxy('lua', repo, { ...next, name: 'next' });
await later.initialize(repo);
check(await until(() => ![stubPid, helperPid].some(alive), 15000), "the next manager's start stops what was left of the stub");
const swept = /stopped what was left of a Svelte server for (.*) \(server pid (\d+)\): pids ([\d, ]+); its manager pid (\d+) is gone/.exec(managerLog(next.LSP_KIT_PIPE));
check(
	swept?.[1] === repo && Number(swept[2]) === stubPid && swept[3].split(', ').includes(String(helperPid)) && Number(swept[4]) === svelte.manager,
	`it logs the stop with the pids, language and why: ${swept?.[0]}`
);
const forgedPath = join(data, `${RECORDS}forged.json`);
check(await until(() => !existsSync(forgedPath), 15000), "the sweep finishes: the gone manager's forged record is removed");
check(!alive(predecessor) && !existsSync(samePath), `a record naming this manager's own pipe under another id is swept: its process (pid ${predecessor}) stopped`);
check(alive(lookAlike), `the look-alike lsp-kit didn't start (pid ${lookAlike}) still runs, though a gone manager's record names its pid`);
check(alive(livePid) && existsSync(liveRecord), `the live manager's server (pid ${livePid}) still runs and its record stays`);
const stop = (pid) => {
	try {
		process.kill(pid);
	} catch {} // already gone
};
stop(lookAlike);
await later.close();

// A record that can't be written (no file may be created in the data folder) is
// logged, and the manager goes on serving; the next start of a server retries.
const deny = (on) =>
	process.platform === 'win32'
		? execFileSync('icacls', [data, on ? '/deny' : '/remove:d', `${userInfo().username}${on ? ':(WD)' : ''}`], { stdio: 'pipe' })
		: chmodSync(data, on ? 0o555 : 0o755);
deny(true);
let served;
try {
	served = await refs(live, wt);
	await until(() => /servers not recorded \(retried at the next measurement\): /.test(managerLog(liveEnv.LSP_KIT_PIPE)), 10000);
} finally {
	deny(false);
}
check(/servers not recorded \(retried at the next measurement\): /.test(managerLog(liveEnv.LSP_KIT_PIPE)), 'a record that can not be written is logged');
check(served === '3 refs' && (await refs(live, repo)) === '3 refs' && alive(live.manager), `the manager (pid ${live.manager}) goes on serving: ${served}`);
await live.close();
check(await until(() => ![stubPid, helperPid, lookAlike].some(alive), 5000), 'no stub process is left running');
[stubPid, helperPid, lookAlike, predecessor].forEach(stop); // after a failure above
finish();
