// Response shaping (shape.mjs): unit checks on synthetic payloads for the
// documentSymbol outline rule and the location dedupe/sort, then one
// end-to-end documentSymbol from a real Lua server through the proxy, raw
// (LSPKIT_RAW=1) beside shaped, on one shared manager.
// Usage: node test/shape.mjs <scratchDir>   (needs lua-language-server)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NAVIGATIONAL, shape } from '../plugins/lsp-kit/shape.mjs';
import { check, finish, killManager, log, privatePipe, scratch, startProxy, wait } from './client.mjs';

// ---- unit: the documentSymbol outline ------------------------------------------

// SymbolKind numbers used here: Module, Class, Method, Function, Field,
// Property, Variable, Number, Object.
const sym = (name, kind, children) => ({ name, kind, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } }, selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } }, ...(children ? { children } : {}) });
const METHOD = 6, FUNCTION = 12, VARIABLE = 13, FIELD = 8, PROPERTY = 7, CLASS = 5, MODULE = 2, NUMBER = 16, OBJECT = 19;
const tree = [
	sym('M', VARIABLE, [
		sym('plain', FIELD),
		sym('cfg', OBJECT, [sym('a', FIELD), sym('b', OBJECT, [sym('deep', FIELD)])]),
		sym('fn', FIELD, [sym('body', FUNCTION, [sym('localY', VARIABLE)])])
	]),
	sym('soloTop', FIELD),
	sym('api', MODULE, [sym('Klass', CLASS, [sym('prop', PROPERTY), sym('method', METHOD)])]),
	sym('helper', FUNCTION, [sym('localZ', VARIABLE)])
];
const shapedTree = shape('textDocument/documentSymbol', tree);
check(
	JSON.stringify(shapedTree) ===
		JSON.stringify([
			{ ...sym('M', VARIABLE), children: [{ ...sym('fn', FIELD), children: [sym('body', FUNCTION)] }] },
			sym('soloTop', FIELD),
			sym('api', MODULE, [sym('Klass', CLASS, [sym('method', METHOD)])]),
			sym('helper', FUNCTION)
		]),
	'documentSymbol: navigational kinds kept at any depth, file-level kinds kept, deeper fields dropped unless they lead to a kept child, emptied children removed'
);
check(shapedTree[2].children[0].children[0] === tree[2].children[0].children[1], 'documentSymbol: a node whose children survived unchanged is not copied');
const flat = [{ name: 'x', kind: VARIABLE, location: { uri: 'file:///a.lua', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }];
check(shape('textDocument/documentSymbol', flat) === flat, 'documentSymbol: a flat SymbolInformation[] answer passes through');
check(shape('textDocument/documentSymbol', null) === null, 'documentSymbol: a null answer passes through');

// ---- unit: locations -----------------------------------------------------------

const loc = (uri, line, character, endCharacter = character + 5) => ({ uri, range: { start: { line, character }, end: { line, character: endCharacter } } });
const locs = [loc('file:///b.lua', 5, 2), loc('file:///a.lua', 10, 0), loc('file:///a.lua', 2, 4), loc('file:///b.lua', 5, 2), loc('file:///a.lua', 10, 3)];
check(
	JSON.stringify(shape('textDocument/references', locs)) === JSON.stringify([loc('file:///a.lua', 2, 4), loc('file:///a.lua', 10, 0), loc('file:///a.lua', 10, 3), loc('file:///b.lua', 5, 2)]),
	'locations: identical entries deduped, then sorted by uri, line, character'
);
const links = [
	{ targetUri: 'file:///b.lua', targetRange: loc('file:///b.lua', 1, 0).range },
	{ targetUri: 'file:///a.lua', targetRange: loc('file:///a.lua', 0, 3).range }
];
check(shape('textDocument/definition', links)[0].targetUri === 'file:///a.lua', 'locations: LocationLink entries sort by their target');
const link = (origin) => ({ originSelectionRange: origin, targetUri: 'file:///a.lua', targetRange: loc('file:///a.lua', 3, 0).range });
check(shape('textDocument/definition', [link(loc('file:///b.lua', 0, 0).range), link(loc('file:///b.lua', 5, 2).range), link(loc('file:///b.lua', 0, 0).range)]).length === 2, 'locations: two LocationLinks to one target from different origins both stay; an exact duplicate still goes');
check(shape('textDocument/definition', [loc('file:///a.lua', 1, 0, 5), loc('file:///a.lua', 1, 0, 9)]).map((l) => l.range.end.character).join(',') === '5,9', 'locations: equal sort keys keep their order (stable)');
check(shape('textDocument/references', Array.from({ length: 300 }, (_, i) => loc('file:///a.lua', i, 0))).length === 300, 'locations: the list is never capped');
const odd = [{ uri: 'file:///a.lua' }];
check(shape('textDocument/references', odd) === odd, 'locations: an entry without a range passes the whole list through');
const hover = { contents: { kind: 'markdown', value: 'x' } };
check(shape('textDocument/hover', hover) === hover, 'hover passes through');
process.env.LSPKIT_RAW = '1';
check(shape('textDocument/references', locs) === locs, 'LSPKIT_RAW=1 passes responses through');
delete process.env.LSPKIT_RAW;

// ---- end to end: one real answer, raw beside shaped ----------------------------

const root = join(process.argv[2], 'project');
scratch(process.argv[2]);
mkdirSync(root, { recursive: true });
const text = 'local M = {}\nM.plain = 1\nM.cfg = { nested = { deep = 2 } }\nfunction M.fn(x) local y = x + 1 return y end\nlocal function top() local z = 1 end\nreturn M\n';
writeFileSync(join(root, '.luarc.json'), '{"runtime.version":"Lua 5.1"}');
writeFileSync(join(root, 'o.lua'), text);
const uri = pathToFileURL(join(root, 'o.lua')).href;
const pipe = privatePipe();
const raw = startProxy('lua', root, { name: 'raw', LSP_KIT_PIPE: pipe, LSPKIT_RAW: '1' });
const shaped = startProxy('lua', root, { name: 'shaped', LSP_KIT_PIPE: pipe });
const outline = async (client) => {
	await client.initialize(root);
	client.open(uri, 'lua', text);
	for (let i = 0; i < 45; i++) {
		const r = await client.req('textDocument/documentSymbol', { textDocument: { uri } });
		if (r?.error || (Array.isArray(r) && r.length)) return r;
		await wait(1000); // empty while LuaLS loads the workspace
	}
	return null;
};
const rawAnswer = await outline(raw);
const shapedAnswer = await outline(shaped);
check(!rawAnswer?.error && !shapedAnswer?.error, `a real Lua server answers documentSymbol through both proxies (${rawAnswer?.error ?? shapedAnswer?.error ?? 'ok'})`);
const names = (list) => (list ?? []).flatMap((s) => [s.name, ...names(s.children)]);
const rawNames = names(rawAnswer);
const shapedNames = names(shapedAnswer);
check(['M', 'M.plain', 'M.cfg', 'nested', 'deep', 'M.fn', 'top'].every((n) => rawNames.includes(n)), `the raw answer keeps file-level fields and nested tables (${rawNames.join(', ')})`);
check(['M', 'M.plain', 'M.cfg', 'M.fn', 'top'].every((n) => shapedNames.includes(n)), `the shaped answer keeps the file-level outline (${shapedNames.join(', ')})`);
check(!shapedNames.includes('nested') && !shapedNames.includes('deep'), 'the shaped answer drops table fields deeper than file level');
const depth = (list, d = 1) => (list ?? []).every((s) => d === 1 || NAVIGATIONAL.has(s.kind) || s.children?.length) && (list ?? []).every((s) => depth(s.children, d + 1));
check(depth(shapedAnswer), 'the shaped answer keeps no childless non-navigational symbol below file level');
log(`documentSymbol payload: raw ${JSON.stringify(rawAnswer).length} bytes, shaped ${JSON.stringify(shapedAnswer).length} bytes`);
await raw.close();
await shaped.close();
killManager(raw.manager);
killManager(shaped.manager);
finish();
