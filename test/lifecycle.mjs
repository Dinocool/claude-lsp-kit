// Lifecycle test for the lsp-kit proxy (Lua): crash of a worktree server, then
// removing a worktree while its server runs. Uses a throwaway repo under <dir>.
// Usage: node test/lifecycle.mjs <scratchDir>   (needs lua-language-server and git)
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const t0 = Date.now();
const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
const proxy = spawn(process.execPath, [fileURLToPath(new URL('../plugins/lsp-kit/proxy.mjs', import.meta.url)), 'lua'], { cwd: repo });
proxy.stderr.on('data', (d) => d.toString().split('\n').filter((l) => l.startsWith('lsp-kit')).forEach((l) => log(l)));
proxy.on('exit', (c) => log(`PROXY EXITED code ${c}`));
let buf = Buffer.alloc(0), id = 0;
const waits = new Map();
const write = (m) => { const b = Buffer.from(JSON.stringify(m)); proxy.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b])); };
const req = (method, params) => new Promise((res) => (waits.set(++id, res), write({ jsonrpc: '2.0', id, method, params })));
proxy.stdout.on('data', (d) => {
	buf = Buffer.concat([buf, d]);
	for (;;) {
		const h = buf.indexOf('\r\n\r\n'); if (h < 0) return;
		const n = +/Content-Length: (\d+)/.exec(buf.subarray(0, h))[1]; if (buf.length < h + 4 + n) return;
		const m = JSON.parse(buf.subarray(h + 4, h + 4 + n)); buf = buf.subarray(h + 4 + n);
		if (m.id != null && !m.method && waits.has(m.id)) waits.get(m.id)(m.error ? { error: m.error.message } : m.result);
		else if (m.id != null && m.method) write({ jsonrpc: '2.0', id: m.id, result: null });
	}
});
const refs = async (file) => {
	const uri = pathToFileURL(file).href;
	const r = await req('textDocument/references', { textDocument: { uri }, position: { line: 0, character: 16 }, context: { includeDeclaration: true } });
	return r?.error ? `ERROR ${r.error}` : `${r?.length ?? 0} refs`;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lualsPids = () => sh('powershell -NoProfile -Command "(Get-Process lua-language-server -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -ExpandProperty Id) -join \',\'"', base).split(',').filter(Boolean);

const before = new Set(lualsPids());
const rootUri = pathToFileURL(repo).href;
await req('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'repo' }], capabilities: {} });
write({ jsonrpc: '2.0', method: 'initialized', params: {} });
log('main: ' + (await refs(join(repo, 'a.lua'))));
log('worktree: ' + (await refs(join(wt, 'a.lua'))));

// 1. Crash the worktree server (the newest LuaLS this proxy started).
const mine = lualsPids().filter((p) => !before.has(p));
log(`killing worktree LuaLS pid ${mine.at(-1)} (proxy owns ${mine.length})`);
sh(`taskkill /F /PID ${mine.at(-1)}`, base);
await wait(1500);
log('worktree after crash: ' + (await refs(join(wt, 'a.lua'))));
log('main after crash: ' + (await refs(join(repo, 'a.lua'))));

// 2. Remove the worktree while its (restarted) server is alive.
try {
	sh('git worktree remove --force .claude/worktrees/wt');
	log(`git worktree remove: ok (dir exists: ${existsSync(wt)})`);
} catch (e) {
	log(`git worktree remove FAILED: ${e.stderr?.toString().trim()}`);
}
log('main after removal: ' + (await refs(join(repo, 'a.lua'))));
await req('shutdown', null);
write({ jsonrpc: '2.0', method: 'exit', params: null });
await wait(2500);
process.exit(0);
