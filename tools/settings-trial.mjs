// Trials of language server settings: each candidate runs the real server on a
// corpus, its memory is read once indexing settles and again after a fixed
// script of lookups, and its answers are compared exactly with the baseline's
// (no lsp-kit settings). A setting earns a place in languages.mjs only with
// less memory and identical answers.
//
// Usage: node tools/settings-trial.mjs <rust|lua> <root> <scratchDir> <file>... [--runs n] [--only a,b] [--fresh]
//   <file>: three or so files under <root>, the source of the lookups and the
//   files whose diagnostics are compared. The lookups are derived once, from
//   the baseline's answers (<scratchDir>/lookups.json), and reused; each
//   candidate's runs are kept in <scratchDir>/<name>.json, so a rerun only
//   runs what is missing (--runs per candidate, 1; --fresh starts over;
//   --only picks candidates). The table is printed from every kept run.
//
// The server is started as the manager starts it (languages.mjs: command,
// initializationOptions; the client capabilities Claude Code sends plus the
// manager's), but by this script alone, so a candidate can set anything.
// Memory is the manager's reading: the server's process tree's commit charge
// on Windows, resident memory elsewhere (processes.mjs). Readings hold under
// machine load; times don't, so they are printed but decide nothing.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES, cargoManifests } from '../plugins/lsp-kit/languages.mjs';
import { processes, tree } from '../plugins/lsp-kit/processes.mjs';
import { frame, readFrames } from '../plugins/lsp-kit/rpc.mjs';

// Each candidate overlays the baseline: `init` goes into initializationOptions
// (rust-analyzer's configuration), `settings` answers workspace/configuration by
// section (LuaLS's client configuration, which a .luarc.json overrides per key),
// `luarc` rewrites the root's .luarc.json for the run (a project setting, for
// what the client layer can't override). The Libs candidates are for the
// trial's WoW addon: its addon/Libs holds Ace3, HereBeDragons and its own
// widget kit.
const ignoring = (dir) => (rc) => ({ ...rc, 'workspace.ignoreDir': [...(rc['workspace.ignoreDir'] ?? []), dir] });
const CANDIDATES = {
	rust: {
		baseline: {},
		'cachePriming off': { init: { cachePriming: { enable: false } } },
		'lru.capacity 32': { init: { lru: { capacity: 32 } } },
		'procMacro off': { init: { procMacro: { enable: false } } },
		'numThreads 2': { init: { numThreads: 2, cachePriming: { numThreads: 2 } } },
		'own target dir': { init: { cargo: { targetDir: true } } }
	},
	lua: {
		baseline: {},
		'no workspace diagnosis': { settings: { Lua: { diagnostics: { workspaceDelay: -1 } } } },
		'maxPreload 100': { settings: { Lua: { workspace: { maxPreload: 100 } } } },
		'preloadFileSize 100 KB': { settings: { Lua: { workspace: { preloadFileSize: 100 } } } },
		'Libs as library': { settings: { Lua: { workspace: { library: ['addon/Libs'] } } } },
		'Libs ignored': { luarc: ignoring('/addon/Libs/') }
	}
};

const SETTLE_MS = 60 * 1000; // settled: memory moved less than SETTLE_SHARE over this long
const SETTLE_SHARE = 0.02;
const POLL_MS = 5000;
const MAX_SETTLE_MS = 20 * 60 * 1000;
const PICKS_PER_FILE = 5;
const QUERIES = 5;
const KINDS = new Set([5, 6, 10, 11, 12, 23]); // Class, Method, Enum, Interface, Function, Struct

const [language, root, scratch, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const value = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
const only = value('--only')?.split(',');
const runs = Number(value('--runs') ?? 1);
const files = rest.filter((a, i) => !a.startsWith('--') && !['--only', '--runs'].includes(rest[i - 1]));
if (!CANDIDATES[language] || !root || !scratch || !files.length) {
	console.error('usage: node tools/settings-trial.mjs <rust|lua> <root> <scratchDir> <file>... [--runs n] [--only a,b] [--fresh]');
	process.exit(2);
}
mkdirSync(scratch, { recursive: true });
const t0 = Date.now();
const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const size = (b) => (b == null ? '-' : b < 2 ** 30 ? `${Math.round(b / 2 ** 20)} MB` : `${(b / 2 ** 30).toFixed(2)} GB`);
const uriOf = (file) => pathToFileURL(join(root, file)).href;
const rel = (uri) => relative(root, fileURLToPath(uri)).replaceAll('\\', '/');

// ---- one server, as the manager starts it ---------------------------------------

function start(candidate) {
	const lang = LANGUAGES[language];
	const { command, args } = lang.server(root);
	const child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
	child.stderr.resume();
	const waits = new Map();
	const pushed = new Map(); // path under the root -> last published diagnostics
	let ids = 0;
	let lastPush = 0;
	const send = (msg) => child.stdin.write(frame({ jsonrpc: '2.0', ...msg }));
	readFrames(child.stdout, (msg) => {
		if (msg.id != null && !msg.method) return waits.get(msg.id)?.(msg), waits.delete(msg.id);
		if (msg.method === 'textDocument/publishDiagnostics') return pushed.set(rel(msg.params.uri), msg.params.diagnostics), (lastPush = Date.now());
		if (msg.id == null) return;
		const result = msg.method === 'workspace/configuration' ? msg.params.items.map((i) => candidate.settings?.[i.section] ?? null) : null;
		send({ id: msg.id, result });
	});
	const request = (method, params) => new Promise((res) => (waits.set(++ids, res), send({ id: ids, method, params })));
	const uri = pathToFileURL(root).href;
	// Claude Code's client capabilities, as its initialize sends them (it
	// advertises workspace/configuration only for a plugin server with
	// `settings`), plus the manager's.
	const capabilities = {
		workspace: { configuration: !!candidate.settings, workspaceFolders: false, didChangeWatchedFiles: { dynamicRegistration: true }, diagnostics: { refreshSupport: true } },
		textDocument: {
			synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
			publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: false, codeDescriptionSupport: true, dataSupport: false },
			hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
			definition: { dynamicRegistration: false, linkSupport: true },
			references: { dynamicRegistration: false },
			documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
			callHierarchy: { dynamicRegistration: false }
		},
		general: { positionEncodings: ['utf-16'] }
	};
	const initializationOptions = { ...lang.settings?.(root), ...candidate.init };
	const ready = request('initialize', { processId: process.pid, rootUri: uri, rootPath: root, workspaceFolders: [{ uri, name: 'trial' }], capabilities, initializationOptions }).then(
		(r) => (send({ method: 'initialized', params: {} }), r.result)
	);
	return { child, request, send, ready, pushed, quiet: () => Date.now() - lastPush };
}

async function memory(pid) {
	const list = await processes();
	return tree(list, pid).reduce((n, p) => n + p.bytes, 0);
}

// Settled once the last SETTLE_MS of readings span less than SETTLE_SHARE.
async function settle(pid) {
	const readings = [];
	let peak = 0;
	for (const end = Date.now() + MAX_SETTLE_MS; Date.now() < end; await wait(POLL_MS)) {
		const bytes = await memory(pid);
		peak = Math.max(peak, bytes);
		readings.push({ at: Date.now(), bytes });
		const window = readings.filter((r) => r.at >= Date.now() - SETTLE_MS);
		if (readings[0].at > Date.now() - SETTLE_MS - POLL_MS) continue;
		const lo = Math.min(...window.map((r) => r.bytes));
		const hi = Math.max(...window.map((r) => r.bytes));
		if (hi - lo <= SETTLE_SHARE * hi) return { bytes, peak };
	}
	return { bytes: await memory(pid), peak, unsettled: true };
}

// ---- answers --------------------------------------------------------------------

const range = (r) => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
const location = (l) => (l.targetUri ? `${rel(l.targetUri)}@${range(l.targetSelectionRange)}` : `${rel(l.uri)}@${range(l.range)}`);
const flatSymbols = (list, out = []) => {
	for (const s of list ?? []) out.push(s), flatSymbols(s.children, out);
	return out;
};
const hoverText = (h) => {
	const c = h?.contents;
	if (!c) return null;
	return (Array.isArray(c) ? c : [c]).map((x) => (typeof x === 'string' ? x : x.value)).join('\n');
};
const NORMALIZE = {
	'textDocument/definition': (r) => [r ?? []].flat().map(location).sort(),
	'textDocument/references': (r) => (r ?? []).map(location).sort(),
	'textDocument/hover': hoverText,
	'textDocument/documentSymbol': (r) => flatSymbols(r).map((s) => `${s.name}|${s.kind}|${s.range ? range(s.range) : location(s.location)}`),
	'workspace/symbol': (r) => (r ?? []).map((s) => `${s.name}|${s.kind}|${s.location.range ? location(s.location) : rel(s.location.uri)}`).sort()
};

const CONTENT_MODIFIED = -32801;
async function ask(server, method, params) {
	for (let i = 0; ; i++) {
		const r = await server.request(method, params);
		if (r.error?.code === CONTENT_MODIFIED && i < 20) {
			await wait(1000);
			continue;
		}
		return r.error ? { error: r.error.message } : r.result;
	}
}

// The lookups, derived from the baseline's answers: per file a few symbols
// (functions, methods, types) spread over its outline, each asked for its
// references and hover at its name and its definition from its first use
// elsewhere; workspace symbol queries for the first few names.
async function derive(server) {
	const lookups = [];
	const names = [];
	for (const file of files) {
		const doc = { textDocument: { uri: uriOf(file) } };
		const symbols = flatSymbols(await ask(server, 'textDocument/documentSymbol', doc)).filter((s) => KINDS.has(s.kind) && s.selectionRange);
		const step = Math.max(1, Math.floor(symbols.length / PICKS_PER_FILE));
		for (const s of symbols.filter((_, i) => i % step === 0).slice(0, PICKS_PER_FILE)) {
			const at = { ...doc, position: s.selectionRange.start };
			lookups.push({ method: 'textDocument/references', params: { ...at, context: { includeDeclaration: true } } }, { method: 'textDocument/hover', params: at });
			const refs = (await ask(server, 'textDocument/references', { ...at, context: { includeDeclaration: false } })) ?? [];
			const use = refs.find?.((l) => l.uri !== doc.textDocument.uri || l.range.start.line !== s.selectionRange.start.line) ?? null;
			lookups.push({ method: 'textDocument/definition', params: use ? { textDocument: { uri: use.uri }, position: use.range.start } : at });
			names.push(s.name.replace(/\(.*$/, '').split(/[.:]/).pop());
		}
	}
	for (const query of [...new Set(names)].slice(0, QUERIES)) lookups.push({ method: 'workspace/symbol', params: { query } });
	return lookups;
}

// Diagnostics of the open files: the last pushed set and, from a server that
// answers pulls, the pulled one; then how many other files have any pushed.
// A server spells a uri its own way (LuaLS: file:///d%3A/...), so pushes are
// keyed by the path under the root.
async function diagnostics(server, init) {
	await wait(10 * 1000);
	for (const end = Date.now() + 120 * 1000; Date.now() < end && server.quiet() < 10 * 1000; ) await wait(1000);
	const out = {};
	for (const file of files) {
		const pulled = init.capabilities?.diagnosticProvider ? (await ask(server, 'textDocument/diagnostic', { textDocument: { uri: uriOf(file) } }))?.items ?? [] : [];
		out[file] = [...(server.pushed.get(file) ?? []), ...pulled].map((d) => `${range(d.range)} ${d.code ?? ''} ${d.message.split('\n')[0]}`).sort();
	}
	const others = [...server.pushed].filter(([file, list]) => !files.includes(file) && list.length);
	return { files: out, otherFiles: others.length, otherCount: others.reduce((n, [, l]) => n + l.length, 0), others: Object.fromEntries(others.map(([file, l]) => [file, l.length])) };
}

// Disk a candidate's own target dirs take (cargo.targetDir true:
// target/rust-analyzer), emptied before each run so its size is that run's.
function dirBytes(dir) {
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size;
	return n;
}
const ownTargetDirs = () => (language === 'rust' ? cargoManifests(root).map((m) => join(dirname(m), 'target', 'rust-analyzer')) : []);
const ownTargets = () => ownTargetDirs().reduce((n, dir) => n + dirBytes(dir), 0);

async function run(name, candidate, lookupsFile) {
	for (const dir of ownTargetDirs()) rmSync(dir, { recursive: true, force: true });
	if (!candidate.luarc) return trial(name, candidate, lookupsFile);
	const luarc = join(root, '.luarc.json');
	const text = readFileSync(luarc, 'utf8');
	writeFileSync(luarc, JSON.stringify(candidate.luarc(JSON.parse(text)), null, '\t'));
	try {
		return await trial(name, candidate, lookupsFile);
	} finally {
		writeFileSync(luarc, text);
	}
}

async function trial(name, candidate, lookupsFile) {
	log(`${name}: starting`);
	const server = start(candidate);
	const init = await server.ready;
	const started = Date.now();
	const settled = await settle(server.child.pid);
	const indexS = (Date.now() - started) / 1000;
	log(`${name}: settled at ${size(settled.bytes)} (peak ${size(settled.peak)}) after ${indexS.toFixed(0)} s${settled.unsettled ? ' (NOT settled)' : ''}`);
	for (const file of files) server.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: uriOf(file), languageId: language, version: 1, text: readFileSync(join(root, file), 'utf8') } } });
	if (!existsSync(lookupsFile)) writeFileSync(lookupsFile, JSON.stringify(await derive(server), null, 1));
	const lookups = JSON.parse(readFileSync(lookupsFile, 'utf8'));
	const askedAt = Date.now();
	const answers = [];
	for (const file of files) answers.push(NORMALIZE['textDocument/documentSymbol'](await ask(server, 'textDocument/documentSymbol', { textDocument: { uri: uriOf(file) } })));
	for (const l of lookups) {
		const r = await ask(server, l.method, l.params);
		answers.push(r?.error ? r : NORMALIZE[l.method](r));
	}
	const lookupS = (Date.now() - askedAt) / 1000;
	const diags = await diagnostics(server, init);
	const after = await memory(server.child.pid);
	log(`${name}: ${lookups.length + files.length} lookups in ${lookupS.toFixed(1)} s; ${size(after)} after them`);
	await Promise.race([server.request('shutdown', null), wait(10000)]);
	server.send({ method: 'exit', params: null });
	await Promise.race([new Promise((r) => server.child.on('exit', r)), wait(10000)]);
	for (const p of tree(await processes(), server.child.pid)) {
		try {
			process.kill(p.pid);
		} catch {} // gone already
	}
	return { name, candidate, settled: settled.bytes, peak: settled.peak, unsettled: !!settled.unsettled, after, indexS, lookupS, answers, diagnostics: diags, ownTargets: ownTargets() };
}

const resultFile = (name) => join(scratch, `${name.replace(/[^\w.-]+/g, '-')}.json`);
const lookupsFile = join(scratch, 'lookups.json');
const kept = (name) => (existsSync(resultFile(name)) ? JSON.parse(readFileSync(resultFile(name), 'utf8')) : []);
const names = Object.keys(CANDIDATES[language]).filter((n) => n === 'baseline' || !only || only.includes(n));
if (flag('--fresh')) for (const f of [lookupsFile, ...names.map(resultFile)]) rmSync(f, { force: true });
// Runs interleave the candidates, so a drift in the machine's state spreads over all of them.
for (let k = 1; k <= runs; k++)
	for (const name of names) if (kept(name).length < k) writeFileSync(resultFile(name), JSON.stringify([...kept(name), await run(name, CANDIDATES[language][name], lookupsFile)], null, 1));

// ---- the table --------------------------------------------------------------------

// An answer that varies between the baseline's own runs (rust-analyzer's
// reference counts do, by a few) can't tell a candidate apart: it is left out.
const all = Object.keys(CANDIDATES[language]).map(kept).filter((r) => r.length);
const bases = all.find((r) => r[0].name === 'baseline');
const base = bases[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unstable = new Set(base.answers.map((_, i) => i).filter((i) => bases.some((r) => !same(r.answers[i], base.answers[i]))));
const steadyFiles = Object.keys(base.diagnostics.files).filter((f) => bases.every((r) => same(r.diagnostics.files[f], base.diagnostics.files[f])));
const spread = (list, key) => {
	const values = list.map((r) => r[key]);
	const [lo, hi] = [Math.min(...values), Math.max(...values)];
	return lo === hi ? size(lo) : `${size(lo)} to ${size(hi)}`;
};
const verdict = (list, differ) => {
	const n = Math.max(...list.map(differ));
	return n ? `${n} differ` : 'same';
};
const answersDiffer = (r) => r.answers.filter((a, i) => !unstable.has(i) && !same(a, base.answers[i])).length;
const diagnosticsDiffer = (r) => steadyFiles.filter((f) => !same(r.diagnostics.files[f], base.diagnostics.files[f])).length;
const counts = (r) => Object.values(r.diagnostics.files).map((l) => l.length).join('/');
console.log(`\n${LANGUAGES[language].name} on ${root}, ${bases.length} baseline runs`);
console.log(`- ${base.answers.length - unstable.size} answers compared, ${unstable.size} left out as they vary between baseline runs`);
console.log(`- diagnostics of ${files.join(', ')} (${counts(base)}), ${files.length - steadyFiles.length} files left out`);
console.log('| candidate | runs | settled | after lookups | peak | answers | diagnostics, open files | other files diagnosed | own target dirs | index s | lookups s |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const list of all) {
	const last = list.at(-1);
	console.log(
		`| ${last.name} | ${list.length}${list.some((r) => r.unsettled) ? ' (unsettled)' : ''} | ${spread(list, 'settled')} | ${spread(list, 'after')} | ${spread(list, 'peak')} | ${verdict(list, answersDiffer)} | ${verdict(list, diagnosticsDiffer)} | ${list.map((r) => r.diagnostics.otherFiles).join(', ')} | ${last.ownTargets ? size(last.ownTargets) : '-'} | ${list.map((r) => r.indexS.toFixed(0)).join(', ')} | ${list.map((r) => r.lookupS.toFixed(1)).join(', ')} |`
	);
}
