// Shared servers: three checkouts of one repo (main, a worktree nested in it
// under .claude/worktrees, a sibling worktree) on ONE rust-analyzer, ONE
// TypeScript 7 and ONE svelte-language-server, each checkout a workspace
// folder. An unsaved edit in one checkout is invisible from another; workspace
// symbols come back only from the asking session's folders, while references
// and definitions keep places in other checkouts; a checkout joins at runtime
// (rust-analyzer hears its Cargo.toml; svelte-language-server, told the
// outermost checkouts, restarts for one outside them and resends what was in
// flight, and its fallback for a .svelte file outside every tsconfig reads the
// checkout, not the drive); TypeScript runs from a copy in the plugin data
// folder, outside every checkout; unused checkouts leave, the server restarts with the one
// left once fewer than half its peak remain, and keeps watching it; a server
// killed after answering restarts at once; a .ts file never reaches the
// Svelte server.
// Usage: node test/folders.mjs <scratchDir>   (needs rust-analyzer,
// svelte-language-server, npm and git)
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES } from '../plugins/lsp-kit/languages.mjs';
import { check, finish, log, privatePipe, processPath, scratch, startProxy, wait } from './client.mjs';

scratch(process.argv[2]);
const base = realpathSync.native(process.argv[2]); // the spelling the manager logs
const A = join(base, 'main');
mkdirSync(A);
if (!LANGUAGES.rust.available() || !LANGUAGES.svelte.available(A)) {
	log('SKIP rust-analyzer or svelte-language-server is not installed');
	process.exit(0);
}
const B = join(A, '.claude', 'worktrees', 'b');
const C = join(base, 'c');
const sh = (c, cwd = A) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
const write = (dir, file, text) => (mkdirSync(join(dir, file, '..'), { recursive: true }), writeFileSync(join(dir, file), text));

// Per language: its file, the position of a symbol in it, the hover word on
// disk and in the worktree's unsaved text.
const L = {
	rust: { name: 'Rust', file: 'src/lib.rs', at: [0, 7], disk: 'u32', edited: 'u64', text: 'pub fn helper(x: u32) -> u32 {\n    x\n}\npub fn caller() -> u32 {\n    helper(1)\n}\n' },
	typescript: { name: 'TypeScript and JavaScript', file: 'ts/lib.ts', at: [0, 16], disk: 'number', edited: 'string', text: 'export function helper(x: number): number {\n\treturn x;\n}\nexport const value = helper(1);\n' },
	svelte: { name: 'Svelte', file: 'svelte/App.svelte', at: [2, 5], disk: 'number', edited: 'string', text: '<script lang="ts">\n\timport { helper } from \'../ts/lib.ts\';\n\tlet n: number = helper(1);\n</script>\n\n<p>{n}</p>\n' }
};
const unsaved = { rust: L.rust.text.replace('-> u32 {\n    x', '-> u64 {\n    x as u64'), typescript: L.typescript.text.replace('number {\n\treturn x;', 'string {\n\treturn String(x);'), svelte: L.svelte.text.replace('n: number', 'n: string') };
for (const l of Object.values(L)) write(A, l.file, l.text);
// Outside every tsconfig include and imported by nothing.
write(A, 'orphan/Orphan.svelte', '<script lang="ts">\n\tlet orphan: number = 1;\n</script>\n\n<p>{orphan}</p>\n');
write(A, 'Cargo.toml', '[package]\nname = "kit"\nversion = "0.1.0"\nedition = "2021"\n');
write(A, 'package.json', '{ "name": "kit", "private": true, "type": "module" }\n');
write(A, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', noEmit: true, allowImportingTsExtensions: true }, include: ['ts', 'svelte'] }));
write(A, 'svelte.config.js', 'export default {};\n');
write(A, '.gitignore', 'node_modules/\ntarget/\n.claude/\n');
// main has TypeScript 7 of its own; the worktrees, without node_modules, find
// the same version in npm's global folder: one server serves them all.
sh('npm install --prefer-offline --no-audit --no-fund --silent typescript@7');
const version = JSON.parse(readFileSync(join(A, 'node_modules', 'typescript', 'package.json'), 'utf8')).version;
const globalModules = execSync('npm root -g').toString().trim();
process.env.npm_config_prefix = join(base, 'prefix');
sh(`npm install -g --prefer-offline --no-audit --no-fund --silent typescript@${version}`);
// The machine's svelte-language-server, linked into that prefix.
const prefixModules = join(base, 'prefix', process.platform === 'win32' ? '' : 'lib', 'node_modules');
symlinkSync(join(globalModules, 'svelte-language-server'), join(prefixModules, 'svelte-language-server'), 'junction');
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');
sh(`git worktree add -q "${B}"`);
sh(`git worktree add -q "${C}"`);
// C imports main's helper by path: a place in a folder C's session doesn't use.
write(C, 'ts/use.ts', `import { helper } from '${A.replaceAll('\\', '/')}/ts/lib.ts';\nhelper(2);\n`);

const IDLE_MS = 12000; // checks every 3 s
const env = { LSP_KIT_PIPE: privatePipe(), LSP_KIT_IDLE_MS: String(IDLE_MS), LSP_KIT_TRACE: '1' };
const S = Object.fromEntries(Object.keys(L).map((lang) => [lang, { a: startProxy(lang, A, { ...env, name: `${lang} a` }), b: startProxy(lang, B, { ...env, name: `${lang} b` }) }]));
// Each session looks into main as a, into the worktrees as b.
const sessionFor = (lang, dir) => (dir === A ? S[lang].a : S[lang].b);
const logged = () => S.rust.a.stderr;
const starts = (lang) => logged().filter((l) => l.startsWith(`lsp-kit: ${L[lang].name} server #`) && / live, pid /.test(l));
const lines = (lang, re) => logged().filter((l) => l.startsWith(`lsp-kit: ${L[lang].name} server #`) && re.test(l));
const restarts = (lang) => logged().filter((l) => l.startsWith(`lsp-kit: restarting ${L[lang].name} server #`));
const until = async (cond, ms) => {
	for (const end = Date.now() + ms; !(await cond()) && Date.now() < end; ) await wait(300);
	return cond();
};
const at = (dir, lang, [line, character] = L[lang].at, file = L[lang].file) => ({ textDocument: { uri: pathToFileURL(join(dir, file)).href }, position: { line, character }, context: { includeDeclaration: true } });
const hover = async (lang, dir) => {
	const r = await sessionFor(lang, dir).req('textDocument/hover', at(dir, lang));
	return JSON.stringify(r?.contents ?? r?.error ?? null);
};
// The checkout of each place in an answer: m(ain), b, c, or the path.
const where = (r) =>
	(Array.isArray(r) ? r : r ? [r] : []).map((l) => {
		const p = fileURLToPath(l.uri ?? l.targetUri ?? l.location.uri).toLowerCase();
		return p.startsWith(B.toLowerCase()) ? 'b' : p.startsWith(A.toLowerCase()) ? 'm' : p.startsWith(C.toLowerCase()) ? 'c' : p;
	});

for (const lang of Object.keys(L)) {
	await S[lang].a.initialize(A);
	await S[lang].b.initialize(B);
	check(starts(lang).length === 1 && lines(lang, new RegExp(` adds ${B.replaceAll('\\', '\\\\')} \\(2 folders\\)`)).length === 1, `${lang}: one server for main and its nested worktree, which joined it: ${starts(lang).join(' | ')}`);
}
const tsExe = processPath(Number(/ live, pid (\d+)\)$/.exec(starts('typescript')[0])[1])).toLowerCase();
check(tsExe.startsWith(join(process.env.CLAUDE_PLUGIN_DATA, 'lsp-kit-typescript-').toLowerCase()), `TypeScript runs from its copy in the plugin data folder, outside every checkout and npm's global folder: ${tsExe}`);

// The worktree's sessions open their unsaved text before the pinger asks about
// the file: a request opens a document from disk, and a didOpen after that
// reloads it from disk too (see syncFromDisk).
const svelteCodes = new Map(); // file path -> the codes last published for it to the svelte worktree session
S.svelte.b.onNotification = (m) => m.method === 'textDocument/publishDiagnostics' && svelteCodes.set(fileURLToPath(m.params.uri).toLowerCase(), m.params.diagnostics.map((d) => String(d.code)));
for (const lang of Object.keys(L)) S[lang].b.open(pathToFileURL(join(B, L[lang].file)).href, lang, unsaved[lang]);

// Every checkout in `keep` is used every 7 s, so it stays a folder while the
// rest of the test runs; then only main is, leaving the server unused between.
const keep = new Set([A, B]);
let pinging = true;
const pinger = (async () => {
	while (pinging) {
		for (const dir of keep) for (const lang of Object.keys(L)) await hover(lang, dir);
		await wait(7000);
	}
})();

// ---- an unsaved edit stays in its checkout ------------------------------------------
for (const [lang, { edited, disk }] of Object.entries(L)) {
	let inB, inA;
	await until(async () => (inB = await hover(lang, B)).includes(edited), 90000);
	await until(async () => (inA = await hover(lang, A)).includes(disk), 30000);
	check(inB.includes(edited) && !inA.includes(edited), `${lang}: the unsaved edit in the worktree shows there (${inB}) and not in main (${inA})`);
}
// svelte-language-server publishes normalized URIs (file:///d%3A/...); its
// diagnostics for the unsaved text still reach the session that holds it.
const svelteB = join(B, L.svelte.file).toLowerCase();
await until(() => svelteCodes.get(svelteB)?.includes('2322'), 30000);
check(svelteCodes.get(svelteB)?.includes('2322'), `svelte: the unsaved text's type error reaches the worktree's session: ${JSON.stringify(svelteCodes.get(svelteB))}`);

// ---- answers keep to the asker's folders ---------------------------------------------
const symbols = (lang, dir) => sessionFor(lang, dir).req('workspace/symbol', { query: 'helper' });
for (const lang of ['rust', 'typescript']) {
	let fromA, fromB;
	await until(async () => where((fromA = await symbols(lang, A))).includes('m') && where((fromB = await symbols(lang, B))).includes('b'), 60000);
	check(where(fromA).every((w) => w === 'm') && where(fromB).every((w) => w === 'b'), `${lang}: workspace symbols from main are main's (${where(fromA)}), from the worktree the worktree's (${where(fromB)})`);
}
for (const lang of Object.keys(L)) {
	const refs = await S[lang].a.req('textDocument/references', at(A, lang));
	check(where(refs).length > 0 && where(refs).every((w) => w === 'm'), `${lang}: references from main stay in main: ${where(refs)}`);
}
const svelteDef = await S.svelte.b.req('textDocument/definition', at(B, 'svelte', [2, 17]));
check(where(svelteDef).join() === 'b', `svelte: the definition of an imported .ts function from the worktree is the worktree's: ${where(svelteDef)}`);
const tsToSvelte = await S.svelte.a.req('textDocument/hover', at(A, 'typescript'));
check(/is no Svelte file/.test(tsToSvelte?.error), `svelte: a .ts file never reaches the Svelte server: ${JSON.stringify(tsToSvelte)}`);

// ---- a checkout joins at runtime ---------------------------------------------------------
// The sibling is outside main, so the Svelte server restarts for it, resending
// main's request in flight: a hover in the orphan file, which makes the server
// read the folder it falls back to, main, not a drive. One session asks both,
// so the hover reaches the server before the sibling's request restarts it.
const orphanAsked = Date.now();
const orphan = S.svelte.a.req('textDocument/hover', at(A, 'svelte', [1, 6], 'orphan/Orphan.svelte'));
await S.svelte.a.req('textDocument/hover', at(C, 'svelte'));
const orphanHover = await Promise.race([orphan, wait(30000).then(() => ({ error: 'no answer in 30 s' }))]);
check(restarts('svelte').some((l) => l.includes(`resending 1 in flight: ${C} is outside the folders it was started with`)), `svelte: the sibling restarted the server, resending main's request: ${restarts('svelte').join(' | ')}`);
check(JSON.stringify(orphanHover).includes('orphan: number'), `svelte: the request answers on the new server: ${JSON.stringify(orphanHover)}`);
check(Date.now() - orphanAsked < 20000, `svelte: the orphan file's fallback reads its checkout, not a drive: answered in ${((Date.now() - orphanAsked) / 1000).toFixed(1)} s`);
keep.add(C);
for (const [lang, { disk }] of Object.entries(L)) {
	let r;
	const ok = await until(async () => (r = await hover(lang, C)).includes(disk), 90000);
	check(ok && lines(lang, / adds .* \(3 folders\)/).length === 1, `${lang}: the sibling worktree joins the running server and answers: ${r}`);
}
check(starts('rust').length === 1 && starts('typescript').length === 1, 'still one Rust and one TypeScript server');
check(starts('svelte').length === 2, 'svelte: the one restart');
// C's use.ts imports main's lib.ts: references and definitions there are real
// places in main, a checkout the worktree's session doesn't use.
const useAt = at(C, 'typescript', [1, 0], 'ts/use.ts');
let useRefs;
await until(async () => where((useRefs = await S.typescript.b.req('textDocument/references', useAt))).includes('c'), 30000);
check(where(useRefs).includes('m'), `references from the sibling keep main's places: ${where(useRefs)}`);
const def = await S.typescript.b.req('textDocument/definition', useAt);
check(where(def).join() === 'm', `its definition is main's: ${where(def)}`);
const mainRefs = await S.typescript.a.req('textDocument/references', at(A, 'typescript'));
check(where(mainRefs).includes('c'), `references from main keep the sibling's use: ${where(mainRefs)}`);

// ---- unused checkouts leave; the server restarts with the one left ------------------
keep.delete(B);
keep.delete(C);
const before = Object.fromEntries(Object.keys(L).map((lang) => [lang, starts(lang).length]));
for (const [lang, { disk }] of Object.entries(L)) {
	const shrunk = () => restarts(lang).filter((l) => l.includes('1 live folder: 1 of its peak 3 folders left'));
	await until(() => shrunk().length, 4 * IDLE_MS);
	check(lines(lang, / drops /).length === 2, `${lang}: both worktrees left the server once unused: ${lines(lang, / drops /).join(' | ')}`);
	check(shrunk().length === 1, `${lang}: with 1 of its peak 3 folders left, it restarted with that one`);
	check(starts(lang).length === before[lang] + 1 && starts(lang).at(-1).includes(` for ${A} (`), `${lang}: the new server serves main alone: ${starts(lang).at(-1)}`);
	check(await until(async () => (await hover(lang, A)).includes(disk), 60000), `${lang}: main answers on the new server`);
}
// The old process's exit comes after the restart; main stays watched for the
// new one (rust-analyzer would find the file itself: the trace shows what it is sent).
const oldRust = /server #(\d+) with/.exec(restarts('rust').at(-1))[1];
await until(() => lines('rust', new RegExp(`#${oldRust} for .* exited`)).length, 10000);
const newRust = /server #(\d+) for /.exec(starts('rust').at(-1))[1];
write(A, 'src/extra.rs', 'pub fn fresh_after_restart() {}\n');
const told = () => readFileSync(join(process.env.CLAUDE_PLUGIN_DATA, `${env.LSP_KIT_PIPE}.log`), 'utf8').includes(`trace ->#${newRust} workspace/didChangeWatchedFiles`);
check(await until(told, 10000), 'rust: a file created after the old process exited is sent to the new server');

// ---- a crash restarts it at once -----------------------------------------------------
pinging = false;
await pinger;
const tsStarts = starts('typescript').length;
const tsPid = Number(/ live, pid (\d+)\)$/.exec(starts('typescript').at(-1))[1]);
process.kill(tsPid);
check(await until(() => starts('typescript').length === tsStarts + 1, 10000), `the TypeScript server killed after answering (pid ${tsPid}) restarts without a request: ${starts('typescript').at(-1)}`);
check((await hover('typescript', A)).includes('number'), 'main answers on it');

for (const s of Object.values(S).flatMap((s) => [s.a, s.b])) await s.close();
finish();
