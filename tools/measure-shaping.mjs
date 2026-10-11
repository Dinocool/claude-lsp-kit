// Measures what response shaping (shape.mjs) saves in what Claude Code renders:
// a fixed query set runs through the proxy twice against generated Lua
// fixtures, once raw (LSPKIT_RAW=1) and once shaped, on one shared server, and
// each query prints one line: method, file, raw bytes vs shaped bytes.
// Usage: node tools/measure-shaping.mjs <scratchDir>   (needs lua-language-server)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { killManager, log, privatePipe, scratch, startProxy, wait } from '../test/client.mjs';

const base = process.argv[2];
if (!base) {
	console.error('usage: node tools/measure-shaping.mjs <scratchDir>');
	process.exit(2);
}
scratch(base);
const root = join(base, 'project');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, '.luarc.json'), '{"runtime.version":"Lua 5.1"}');

// One large file of file-level tables with many nested plain fields (what the
// outline prunes) and function-valued fields (what it keeps), plus one with a
// heavily referenced global.
const fields = [`local FIELDS = {}`];
for (let i = 1; i <= 300; i++) {
	fields.push(`FIELDS.item${i} = { value = ${i}, flag = true, label = "item${i}", view = { x = ${i}, y = ${i} } }`);
	if (i % 3 === 0) fields.push(`FIELDS.act${i} = function(self) local t = ${i} return t end`);
}
for (let i = 1; i <= 100; i++) fields.push(`local function handler${i}(a, b) local s = a + b + ${i} return s end`);
fields.push('return FIELDS');
writeFileSync(join(root, 'bigfields.lua'), fields.join('\n') + '\n');
const refs = ['function helper(x) return (x or 0) + 1 end'];
for (let i = 1; i <= 240; i++) refs.push(`local v${i} = helper(${i})`);
writeFileSync(join(root, 'refs.lua'), refs.join('\n') + '\n');
const refs2 = ['local function drive()'];
for (let i = 1; i <= 31; i++) refs2.push(`\thelper(${i})`);
refs2.push('end', 'return drive');
writeFileSync(join(root, 'refs2.lua'), refs2.join('\n') + '\n');

const uriOf = (file) => pathToFileURL(join(root, file)).href;
const texts = Object.fromEntries(['bigfields.lua', 'refs.lua', 'refs2.lua'].map((f) => [f, readFileSync(join(root, f), 'utf8')]));
const queries = [
	{ method: 'textDocument/documentSymbol', params: { textDocument: { uri: uriOf('bigfields.lua') } }, file: 'bigfields.lua' },
	{ method: 'textDocument/documentSymbol', params: { textDocument: { uri: uriOf('refs.lua') } }, file: 'refs.lua' },
	{ method: 'textDocument/references', params: { textDocument: { uri: uriOf('refs.lua') }, position: { line: 0, character: 10 }, context: { includeDeclaration: true } }, file: 'refs.lua helper' }
];

// Two proxies on one manager and one server: the raw one shows what the server
// (and the manager's own Lua outline rewrite) sends, the shaped one what the
// client renders. The same queries run on both.
const pipe = privatePipe();
const raw = startProxy('lua', root, { name: 'raw', LSP_KIT_PIPE: pipe, LSPKIT_RAW: '1' });
const shaped = startProxy('lua', root, { name: 'shaped', LSP_KIT_PIPE: pipe });
const run = async (client) => {
	await client.initialize(root);
	const answers = {};
	for (const { file } of queries) client.open(uriOf(file), 'lua', texts[file]);
	for (const q of queries) {
		for (let i = 0; i < 45; i++) {
			const r = await client.req(q.method, q.params);
			if (r?.error || (Array.isArray(r) ? r.length : r)) {
				answers[q.file] = { r, error: r?.error };
				break;
			}
			await wait(1000); // empty while LuaLS loads the workspace
		}
	}
	return answers;
};
const rawAnswers = await run(raw);
const shapedAnswers = await run(shaped);
for (const q of queries) {
	const r = rawAnswers[q.file];
	const s = shapedAnswers[q.file];
	if (r?.error || s?.error) {
		log(`${q.method.split('/')[1]} ${q.file}: ERROR ${r?.error ?? s?.error}`);
		continue;
	}
	const bytes = (a) => Buffer.byteLength(JSON.stringify(a?.r));
	const from = bytes(r);
	const to = bytes(s);
	log(`${q.method.split('/')[1]} ${q.file}: ${from} bytes raw -> ${to} bytes shaped (${Math.round((100 * to) / from)}%)`);
}
await raw.close();
await shaped.close();
killManager(raw.manager);
killManager(shaped.manager);
