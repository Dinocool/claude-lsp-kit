// TypeScript and JavaScript, in a throwaway repo under <dir> with its own
// TypeScript 7 (npm install; the first run needs the registry or npm's cache)
// and an empty npm global folder: definitions and references across two .ts
// files and an .mjs file importing a .ts file (allowJs, checkJs); two sessions
// share ONE server, the native compiler itself; pulled diagnostics reach the
// client as pushes, never stale; the server counts toward the machine-wide cap
// with the other languages' servers; a TypeScript 6 project with Microsoft's
// side-by-side alias of TypeScript 7.
// Usage: node test/typescript.mjs <scratchDir>   (needs npm, git and lua-language-server)
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES } from '../plugins/lsp-kit/languages.mjs';
import { alive, check, finish, killManager, log, privatePipe, processPath, startProxy, wait } from './client.mjs';

rmSync(process.argv[2], { recursive: true, force: true });
mkdirSync(join(process.argv[2], 'repo'), { recursive: true });
const base = realpathSync.native(process.argv[2]); // the spelling the manager logs
const repo = join(base, 'repo');
// No global TypeScript: npm's global folder (`npm root -g`) follows the prefix setting.
mkdirSync(join(base, 'empty-prefix'));
process.env.npm_config_prefix = join(base, 'empty-prefix');
const sh = (c) => execSync(c, { cwd: repo, stdio: 'pipe' }).toString().trim();
const write = (file, text) => (mkdirSync(join(repo, file, '..'), { recursive: true }), writeFileSync(join(repo, file), text));
write('package.json', '{ "name": "kit", "private": true, "type": "module" }\n');
write(
	'tsconfig.json',
	JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', allowJs: true, checkJs: true, noEmit: true, allowImportingTsExtensions: true }, include: ['src', 'scripts'] })
);
write('src/lib.ts', 'export function helper(x: number): number {\n\treturn x;\n}\n');
write('src/use.ts', "import { helper } from './lib.ts';\nhelper(1);\n");
write('scripts/run.mjs', "import { helper } from '../src/lib.ts';\nhelper(2);\n");
write('.luarc.json', '{"runtime.version":"Lua 5.1"}');
write('a.lua', 'local function helper(x) return x end\nhelper(1)\n');
sh('npm install --prefer-offline --no-audit --no-fund --silent typescript@7');
write('.gitignore', 'node_modules/\n');
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');

const uri = (file) => pathToFileURL(join(repo, file)).href;
const files = (r) => (Array.isArray(r) ? r.map((l) => `${basename(fileURLToPath(l.uri ?? l.targetUri))}:${(l.range ?? l.targetSelectionRange).start.line}`).sort() : r);
// Retried while the server loads the project (empty answers until then).
const ask = async (client, method, file, line, character) => {
	let r;
	for (let i = 0; i < 60; i++) {
		r = await client.req(method, { textDocument: { uri: uri(file) }, position: { line, character }, context: { includeDeclaration: true } });
		if (r?.error || r?.length) break;
		await wait(500);
	}
	return files(r);
};
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);

// ---- navigation, two sessions on one server -----------------------------------------
const data = join(process.argv[2], 'data');
const shared = { LSP_KIT_PIPE: privatePipe(), CLAUDE_PLUGIN_DATA: data, LSP_KIT_TRACE: '1' }; // the manager's log traces every message
const a = startProxy('typescript', repo, { ...shared, name: 'a' });
const b = startProxy('typescript', repo, { ...shared, name: 'b' });
await a.initialize(repo);
await b.initialize(repo);
// No didOpen from the client: the manager opens each file from disk, under its extension's languageId.
let got = await ask(a, 'textDocument/definition', 'src/use.ts', 1, 0);
check(same(got, ['lib.ts:0']), `.ts -> .ts goToDefinition finds helper in lib.ts: ${JSON.stringify(got)}`);
got = await ask(a, 'textDocument/definition', 'scripts/run.mjs', 1, 0);
check(same(got, ['lib.ts:0']), `.mjs -> .ts goToDefinition finds helper in lib.ts: ${JSON.stringify(got)}`);
const allRefs = ['lib.ts:0', 'run.mjs:0', 'run.mjs:1', 'use.ts:0', 'use.ts:1'];
got = await ask(b, 'textDocument/references', 'src/lib.ts', 0, 16);
check(same(got, allRefs), `findReferences from lib.ts (session b) lists the .ts and .mjs uses: ${JSON.stringify(got)}`);
got = await ask(b, 'textDocument/references', 'scripts/run.mjs', 1, 0);
check(same(got, allRefs), `findReferences from run.mjs lists the same: ${JSON.stringify(got)}`);
const starts = a.stderr.filter((l) => / live, pid /.test(l));
check(starts.length === 1, `one server for both sessions: ${starts.length} start line(s)`);
const [pid] = a.pids();
const exe = processPath(pid);
check(/^tsc(\.exe)?$/i.test(basename(exe)) && exe.includes(join('node_modules', '@typescript')), `the manager holds the native compiler itself, the project's own TypeScript 7 (pid ${pid} is ${exe})`);

// ---- diagnostics: TypeScript 7 only answers pulls; the client gets them pushed -------
const pushed = new Map(); // file name -> latest diagnostics messages
let lastPush = 0;
a.onNotification = (m) => m.method === 'textDocument/publishDiagnostics' && (pushed.set(basename(fileURLToPath(m.params.uri)), m.params.diagnostics.map((d) => d.message)), (lastPush = Date.now()));
const until = async (cond, ms) => {
	for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await wait(100);
	return cond();
};
const badText = "export const n: number = 'x';\n";
write('src/bad.ts', badText);
a.open(uri('src/bad.ts'), 'typescript', badText);
const assignError = (file) => pushed.get(file)?.some((m) => /not assignable to type 'number'/.test(m));
check(await until(() => assignError('bad.ts'), 10000), `an error in a file the session opens reaches it as publishDiagnostics: ${JSON.stringify(pushed.get('bad.ts'))}`);
// The pull follows the didOpen itself, not only the server's later refresh request.
const traced = readFileSync(join(data, `${shared.LSP_KIT_PIPE}.log`), 'utf8').split('\n');
const opened = traced.findIndex((l) => / textDocument\/didOpen +\S*\/src\/bad\.ts/.test(l));
const next = traced.slice(opened + 1).find((l) => / textDocument\/diagnostic \S+ \S*\/src\/bad\.ts/.test(l) || / workspace\/diagnostic\/refresh /.test(l));
check(opened >= 0 && / textDocument\/diagnostic /.test(next), `the manager pulls bad.ts's diagnostics after its didOpen, before any refresh: ${next}`);
a.open(uri('src/use.ts'), 'typescript', "import { helper } from './lib.ts';\nhelper(1);\n");
await until(() => pushed.has('use.ts'), 10000);
check(same(pushed.get('use.ts'), []), `use.ts starts clean: ${JSON.stringify(pushed.get('use.ts'))}`);
// lib.ts changes on disk (helper now takes a string) and the server hears it: use.ts's call breaks.
write('src/lib.ts', 'export function helper(x: string): string {\n\treturn x;\n}\n');
a.open(uri('src/lib.ts'), 'typescript', 'export function helper(x: string): string {\n\treturn x;\n}\n');
const callError = () => pushed.get('use.ts')?.some((m) => /not assignable to parameter of type 'string'/.test(m));
check(await until(callError, 10000), `the change re-pulls the other open file, whose error reaches the session: ${JSON.stringify(pushed.get('use.ts'))}`);
write('src/lib.ts', 'export function helper(x: number): number {\n\treturn x;\n}\n');
rmSync(join(repo, 'src', 'bad.ts'));

// ---- stale pulls: after quick edits, the last published set is the last text's -------
// TypeScript 7 answers overlapping pulls out of order: the slow 400-error pull
// can answer after the clean one that followed it. Twenty runs of two edits a
// tick apart (each change's pull reaches the server before the next change),
// ending on the clean or the 400-error text in turn. Without the fix about
// half the runs end stale.
const clean = 'export const ok = 1;\n';
const dirty = clean + Array.from({ length: 400 }, (_, i) => `export const z${i}: number = 'x';\n`).join('');
a.open(uri('src/race.ts'), 'typescript', clean);
await until(() => pushed.has('race.ts'), 10000);
let version = 1;
const wrong = [];
for (let run = 0; run < 20; run++) {
	const [other, final] = run % 2 ? [clean, dirty] : [dirty, clean];
	const runStart = Date.now();
	a.notify('textDocument/didChange', { textDocument: { uri: uri('src/race.ts'), version: ++version }, contentChanges: [{ text: other }] });
	await new Promise((r) => setImmediate(r));
	a.notify('textDocument/didChange', { textDocument: { uri: uri('src/race.ts'), version: ++version }, contentChanges: [{ text: final }] });
	await until(() => lastPush > runStart && Date.now() - lastPush > 400, 5000);
	const errors = pushed.get('race.ts')?.length;
	if (errors !== (final === dirty ? 400 : 0)) wrong.push(`run ${run}: ${errors} errors for the ${final === dirty ? 'dirty' : 'clean'} text`);
}
check(!wrong.length, `the last published set matches the last text in 20 runs of quick edits: ${wrong.join('; ') || 'all'}`);

await a.close();
await b.close();
killManager(a.manager);
check(await (async () => {
	for (let i = 0; i < 50 && alive(pid); i++) await wait(100);
	return !alive(pid);
})(), `the TypeScript server (pid ${pid}) exits with the manager`);

// ---- the machine-wide cap, shared with the other languages ---------------------------
// With a cap of 1, starting the TypeScript server stops the idle Lua server.
const capped = { LSP_KIT_PIPE: privatePipe(), LSP_KIT_MAX_SERVERS: '1' };
const lua = startProxy('lua', repo, { ...capped, name: 'lua' });
await lua.initialize(repo);
const ts = startProxy('typescript', repo, { ...capped, name: 'ts' });
await ts.initialize(repo);
got = await ask(ts, 'textDocument/definition', 'src/use.ts', 1, 0);
check(same(got, ['lib.ts:0']), `the TypeScript server answers under a cap of 1: ${JSON.stringify(got)}`);
check(ts.stderr.some((l) => l.includes(`stopping Lua server #1 for ${repo}`)), 'starting it stopped the Lua server: both count toward one cap');
await lua.close();
await ts.close();
killManager(ts.manager);

// ---- a TypeScript 6 project ---------------------------------------------------------
// Its `typescript` is 6 (Microsoft's @typescript/typescript6 alias) and TypeScript 7
// sits beside it as `@typescript/native`, the side-by-side install the TS 7.0
// announcement recommends; with no global TypeScript, only that alias can serve it.
// Its tsconfig keeps baseUrl, which TS 7 removed: the server says so, and the
// session hears it.
const six = join(base, 'six');
const platform = join('@typescript', `typescript-${process.platform}-${process.arch}`);
mkdirSync(join(six, 'node_modules', 'typescript'), { recursive: true });
mkdirSync(join(six, 'node_modules', '@typescript'));
mkdirSync(join(six, 'src'));
writeFileSync(join(six, 'node_modules', 'typescript', 'package.json'), '{ "name": "@typescript/typescript6", "version": "6.0.3" }');
symlinkSync(join(repo, 'node_modules', 'typescript'), join(six, 'node_modules', '@typescript', 'native'), 'junction');
symlinkSync(join(repo, 'node_modules', platform), join(six, 'node_modules', platform), 'junction');
writeFileSync(join(six, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', ignoreDeprecations: '6.0', noEmit: true }, include: ['src'] }));
writeFileSync(join(six, 'src', 'a.ts'), 'export const a = 1;\n');
const t6 = startProxy('typescript', six, { name: 't6' });
const t6Diags = new Map();
t6.onNotification = (m) => m.method === 'textDocument/publishDiagnostics' && t6Diags.set(basename(fileURLToPath(m.params.uri)), m.params.diagnostics.map((d) => d.message));
await t6.initialize(six);
const note = t6.stderr.find((l) => l.includes('the project has TypeScript'));
check(/the project has TypeScript 6\.0\.3; TypeScript 7\.\S+ from .* serves it/.test(note), `the log names the project's TypeScript 6 next to the TypeScript 7 serving it: ${note}`);
t6.open(pathToFileURL(join(six, 'src', 'a.ts')).href, 'typescript', 'export const a = 1;\n');
const removed = () => t6Diags.get('tsconfig.json')?.some((m) => /'baseUrl' has been removed/.test(m));
check(await until(removed, 10000), `TypeScript 7's tsconfig error reaches the session: ${JSON.stringify(t6Diags.get('tsconfig.json'))}`);
await t6.close();
killManager(t6.manager);

// TypeScript 7 without its platform package: the start error names the package.
const bare = join(base, 'bare');
mkdirSync(join(bare, 'node_modules', 'typescript'), { recursive: true });
writeFileSync(join(bare, 'node_modules', 'typescript', 'package.json'), '{ "name": "typescript", "version": "7.0.2" }');
let startError;
try {
	LANGUAGES.typescript.server(bare);
} catch (e) {
	startError = e.message;
}
check(startError?.includes(`lacks its platform package @typescript/typescript-${process.platform}-${process.arch}`), `a TypeScript 7 without its platform package: ${startError}`);
log(`scratch: ${repo}`);
finish();
