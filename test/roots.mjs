// Roots and the Lua outline: a session started in a SUBDIRECTORY of a repo must
// still root its Lua server at the git toplevel (so the repo's .luarc.json
// applies), a linked worktree outside the session tree gets its own server
// rooted at that worktree, and documentSymbol comes back as the compact outline.
// Builds a throwaway repo under <dir>.
// Usage: node test/roots.mjs <scratchDir>   (needs lua-language-server and git)
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, finish, log, startProxy, wait } from './client.mjs';

const base = process.argv[2];
const repo = join(base, 'repo');
const sub = join(repo, 'addon');
const wt = join(base, 'repo-wt'); // a linked worktree beside the repo, outside the session tree
rmSync(base, { recursive: true, force: true });
mkdirSync(sub, { recursive: true });
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
// Lua 5.1: loadstring is current (5.4 flags it "Deprecated"); undefined globals silenced.
writeFileSync(join(repo, '.luarc.json'), '{"runtime.version":"Lua 5.1","diagnostics.disable":["undefined-global"]}');
writeFileSync(
	join(sub, 'mod.lua'),
	[
		'local M = { limit = 3, cfg = { depth = 2 } }', // 1
		'local function helper(a, b)', //                  2
		'  local sum = a + b', //                          3
		'  if sum > 1 then local twice = sum * 2; return twice end', // 4
		'  local function inner(x) return x end', //       5
		'  pcall(function() return inner(sum) end)', //   6
		'  return sum', //                                 7
		'end', //                                          8
		'function M.run(n)', //                            9
		'  local f = loadstring("return 1")', //           10
		'  for i = 1, n do local v = helper(i, CreateFrame) end', // 11
		'  return f', //                                   12
		'end', //                                          13
		'function M:method() local self2 = self end', //   14
		'return M' //                                      15
	].join('\n') + '\n'
);
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');
sh(`git worktree add -q "${wt}"`);

const client = startProxy('lua', sub);
const diagnostics = new Map(); // lower-cased decoded uri -> diagnostics
const norm = (uri) => decodeURIComponent(uri).toLowerCase();
client.onNotification = (m) => m.method === 'textDocument/publishDiagnostics' && diagnostics.set(norm(m.params.uri), m.params.diagnostics);
const { req, stderr } = client;
const open = (path) => {
	const uri = pathToFileURL(path).href;
	client.open(uri, 'lua', readFileSync(path, 'utf8'));
	return uri;
};
const diagnosticsFor = async (uri) => {
	for (let i = 0; i < 60 && !diagnostics.has(norm(uri)); i++) await wait(500);
	return diagnostics.get(norm(uri));
};
const outline = async (uri) => {
	let r;
	for (let i = 0; i < 30 && !(Array.isArray(r) && r.length); i++) r = await req('textDocument/documentSymbol', { textDocument: { uri } });
	const lines = [];
	const walk = (list, depth) => list?.forEach((s) => (lines.push(`${'  '.repeat(depth)}${s.name} ${s.range.start.line + 1}-${s.range.end.line + 1}`), walk(s.children, depth + 1)));
	walk(r, 0);
	return lines.join('\n');
};

// The client roots the session at the subdirectory, as Claude Code does when its cwd is one.
await client.initialize(sub);
check(stderr.some((l) => l.includes(`server #1 for ${repo} (1 live`)), `session server rooted at the git toplevel ${repo}, not ${sub}`);

const mainUri = open(join(sub, 'mod.lua'));
const diags = (await diagnosticsFor(mainUri)) ?? [];
log(`main diagnostics: ${JSON.stringify(diags.map((d) => `${d.code}: ${d.message.split('\n')[0]}`))}`);
check(!diags.some((d) => d.code === 'deprecated' || d.code === 'undefined-global'), '.luarc.json applies: Lua 5.1 runtime, undefined-global disabled');

const expected = ['M 1-1', '  limit 1-1', '  cfg 1-1', '    depth 1-1', 'helper 2-8', '  inner 5-5', 'M.run 9-13', 'M:method 14-14'].join('\n');
const got = await outline(mainUri);
check(got === expected, `documentSymbol is the outline (no body locals, params, blocks or anonymous callbacks):\n${got}`);
const ws = await req('workspace/symbol', { query: 'twice' });
check(Array.isArray(ws) && ws.some((s) => s.name === 'twice'), 'workspaceSymbol still finds a body local by name');

const wtUri = open(join(wt, 'addon', 'mod.lua'));
check((await outline(wtUri)) === expected, 'the sibling worktree answers too');
check(stderr.some((l) => l.includes(`server #2 for ${wt} `)), `the sibling worktree got its own server rooted at ${wt}`);

await client.close();
sh(`git worktree remove --force "${wt}"`);
finish();
