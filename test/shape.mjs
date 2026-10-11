// Response shaping (shape.mjs): unit checks on synthetic payloads for the
// documentSymbol outline rule and the location dedupe, then one
// end-to-end documentSymbol from a real Lua server through the proxy, raw
// (LSPKIT_RAW=1) beside shaped, on one shared manager.
// Usage: node test/shape.mjs <scratchDir>   (needs lua-language-server)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shape, stays } from '../plugins/lsp-kit/shape.mjs';
import { check, finish, killManager, log, privatePipe, scratch, startProxy, wait } from './client.mjs';

// ---- unit: the documentSymbol outline ------------------------------------------

// SymbolKind numbers used here: Module, Namespace, Class, Method, Constructor,
// Enum, Interface, Function, Struct, Field, Property, Variable, Object,
// EnumMember.
const sym = (name, kind, children) => ({ name, kind, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } }, selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } }, ...(children ? { children } : {}) });
const METHOD = 6, FUNCTION = 12, VARIABLE = 13, FIELD = 8, PROPERTY = 7, CLASS = 5, NAMESPACE = 3, CONSTRUCTOR = 9, ENUM = 10, STRUCT = 23, OBJECT = 19, ENUM_MEMBER = 22;
const outlineOf = (tree) => shape('textDocument/documentSymbol', tree);

// A type's members are its API, whatever their kind.
const widget = [sym('Widget', CLASS, [sym('constructor', CONSTRUCTOR), sym('label', PROPERTY), sym('draw', METHOD)])];
check(JSON.stringify(outlineOf(widget)) === JSON.stringify(widget), 'documentSymbol: a class keeps its constructor, properties and methods');
check(outlineOf(widget)[0] === widget[0], 'documentSymbol: a node whose children survived unchanged is not copied');
check(JSON.stringify(outlineOf([sym('Color', ENUM, [sym('Red', ENUM_MEMBER), sym('Green', ENUM_MEMBER)])])) === JSON.stringify([sym('Color', ENUM, [sym('Red', ENUM_MEMBER), sym('Green', ENUM_MEMBER)])]), 'documentSymbol: an enum keeps its members');
check(JSON.stringify(outlineOf([sym('Point', STRUCT, [sym('x', FIELD), sym('y', FIELD)])])) === JSON.stringify([sym('Point', STRUCT, [sym('x', FIELD), sym('y', FIELD)])]), 'documentSymbol: a struct keeps its fields');

// Namespaces are navigational at any depth; what sits under them follows the
// general rule (a plain field goes).
const namespaces = [sym('Outer', NAMESPACE, [sym('Inner', NAMESPACE, [sym('Deep', NAMESPACE, [sym('plain', FIELD)])])])];
check(JSON.stringify(outlineOf(namespaces)) === JSON.stringify([sym('Outer', NAMESPACE, [sym('Inner', NAMESPACE, [sym('Deep', NAMESPACE)])])]), 'documentSymbol: a namespace nested in a namespace keeps the inner one with its children');

// The path to a kept child stays; a plain field below file level under a
// non-type parent goes, and an emptied children list is removed.
check(JSON.stringify(outlineOf([sym('mod', VARIABLE, [sym('nested', VARIABLE, [sym('run', FUNCTION)])])])) === JSON.stringify([sym('mod', VARIABLE, [sym('nested', VARIABLE, [sym('run', FUNCTION)])])]), 'documentSymbol: a Variable holding a Variable holding a Function keeps the path to the Function');
check(JSON.stringify(outlineOf([sym('mod', VARIABLE, [sym('plain', FIELD), sym('cfg', OBJECT, [sym('a', FIELD)])])])) === JSON.stringify([{ ...sym('mod', VARIABLE) }]), 'documentSymbol: a plain field at depth 2 under a Variable goes');
const flat = [{ name: 'x', kind: VARIABLE, location: { uri: 'file:///a.lua', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }];
check(outlineOf(flat) === flat, 'documentSymbol: a flat SymbolInformation[] answer passes through');
check(outlineOf(null) === null, 'documentSymbol: a null answer passes through');

// ---- unit: locations -----------------------------------------------------------

const loc = (uri, line, character, endCharacter = character + 5) => ({ uri, range: { start: { line, character }, end: { line, character: endCharacter } } });
const locs = [loc('file:///b.lua', 5, 2), loc('file:///a.lua', 10, 0), loc('file:///b.lua', 5, 2), loc('file:///a.lua', 2, 4)];
check(
	JSON.stringify(shape('textDocument/references', locs)) === JSON.stringify([loc('file:///b.lua', 5, 2), loc('file:///a.lua', 10, 0), loc('file:///a.lua', 2, 4)]),
	'locations: a duplicate goes and the server\'s order stays (first seen first)'
);
const links = [
	{ targetUri: 'file:///b.lua', targetRange: loc('file:///b.lua', 1, 0).range },
	{ targetUri: 'file:///a.lua', targetRange: loc('file:///a.lua', 0, 3).range }
];
check(JSON.stringify(shape('textDocument/definition', links)) === JSON.stringify(links), 'locations: LocationLink entries keep the server\'s order too');
const link = (origin) => ({ originSelectionRange: origin, targetUri: 'file:///a.lua', targetRange: loc('file:///a.lua', 3, 0).range });
check(shape('textDocument/definition', [link(loc('file:///b.lua', 0, 0).range), link(loc('file:///b.lua', 5, 2).range), link(loc('file:///b.lua', 0, 0).range)]).length === 2, 'locations: two LocationLinks to one target from different origins both stay; an exact duplicate still goes');
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
// A server that fails to start or answers nothing is a FAIL here, not a crash below.
const why = (a) => (a?.error ? `failed: ${a.error}` : 'answered nothing');
check(Array.isArray(rawAnswer) && Array.isArray(shapedAnswer), `a real Lua server answers documentSymbol through both proxies (raw ${Array.isArray(rawAnswer) ? 'ok' : why(rawAnswer)}, shaped ${Array.isArray(shapedAnswer) ? 'ok' : why(shapedAnswer)})`);
const names = (list) => (Array.isArray(list) ? list.flatMap((s) => [s.name, ...names(s.children)]) : []);
const rawNames = names(rawAnswer);
const shapedNames = names(shapedAnswer);
check(['M', 'M.plain', 'M.cfg', 'nested', 'deep', 'M.fn', 'top'].every((n) => rawNames.includes(n)), `the raw answer keeps file-level fields and nested tables (${rawNames.join(', ')})`);
check(['M', 'M.plain', 'M.cfg', 'M.fn', 'top'].every((n) => shapedNames.includes(n)), `the shaped answer keeps the file-level outline (${shapedNames.join(', ')})`);
check(!shapedNames.includes('nested') && !shapedNames.includes('deep'), 'the shaped answer drops table fields deeper than file level');
const depth = (list, d = 1, parent = 0) => Array.isArray(list ?? []) && (list ?? []).every((s) => stays(s.kind, d, parent) || s.children?.length) && (list ?? []).every((s) => depth(s.children, d + 1, s.kind));
check(depth(shapedAnswer), 'the shaped answer keeps only what the outline rule keeps below file level');
log(`documentSymbol payload: raw ${JSON.stringify(rawAnswer).length} bytes, shaped ${JSON.stringify(shapedAnswer).length} bytes`);
await raw.close();
await shaped.close();
killManager(raw.manager);
killManager(shaped.manager);
finish();
