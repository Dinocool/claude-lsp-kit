// The languages lsp-kit serves; `results` holds per-method response rewrites.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { dataDir } from './rpc.mjs';

const SVELTE_CONFIGS = ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.cjs', 'svelte.config.ts'];
const TS_MARKERS = ['tsconfig.json', 'jsconfig.json', 'package.json'];
// Claude Code routes each file to a language's proxy by plugin.json's
// extensionToLanguage, the one copy of that map.
const PLUGIN = JSON.parse(readFileSync(new URL('./.claude-plugin/plugin.json', import.meta.url), 'utf8'));
const extensionsOf = (key) => Object.values(PLUGIN.lspServers).find((s) => s.args.at(-1) === key).extensionToLanguage;
const TS_EXTENSIONS = Object.keys(extensionsOf('typescript'));
const SKIP_DIRS = new Set(['target', 'node_modules']);

export const LANGUAGES = {
	svelte: {
		name: 'Svelte',
		extensionToLanguage: extensionsOf('svelte'),
		note: 'TypeScript-aware: definitions and references include the .ts/.js files a component imports',
		watch: [...TS_EXTENSIONS, '.json', '.svelte'],
		server: (root) => {
			const path = svelteServer(root);
			if (!path) throw new Error('svelte-language-server not found (npm install -g svelte-language-server)');
			return { command: process.execPath, args: [path, '--stdio'] };
		},
		present: (root) => SVELTE_CONFIGS.some((f) => existsSync(join(root, f))),
		available: (root) => !!svelteServer(root)
	},
	// TypeScript 7's own LSP server (`tsc --lsp`); TS 7 has no tsserver, and the
	// wrappers around TS 6's tsserver can't serve a TS 7 project. It sees no
	// .svelte file: Svelte support needs a tsserver plugin, which TS 7 lacks.
	typescript: {
		name: 'TypeScript and JavaScript',
		extensionToLanguage: extensionsOf('typescript'),
		note: 'TypeScript 7, also for a TypeScript 6 project (TypeScript 7 semantics: a tsconfig option it removed, such as baseUrl, breaks resolution and empties answers); findReferences from a .ts/.js symbol misses its uses in .svelte files (ask from a .svelte use for those), and its errors about *.svelte modules (TS2614 for the named export of a component, say) are its blind spot: svelte-check is the authority',
		watch: [...TS_EXTENSIONS, '.json'],
		server: typescriptServer,
		present: (root) => TS_MARKERS.some((f) => existsSync(join(root, f))),
		available: (root) => !!typescript7(root)
	},
	rust: {
		name: 'Rust',
		extensionToLanguage: extensionsOf('rust'),
		note: 'every crate in the repo, including nested ones; answers come back empty for ~15 s while it indexes, so retry an empty first result',
		watch: ['.rs', '.toml'],
		server: (root) => ({ command: rustAnalyzer(root), args: [] }),
		// rust-analyzer alone only finds Cargo.toml at its root and one level down.
		initializationOptions: (root) => ({ linkedProjects: cargoManifests(root) }),
		present: (root) => cargoManifests(root, 1).length > 0,
		available: () => onPath('rust-analyzer')
	},
	lua: {
		name: 'Lua',
		extensionToLanguage: extensionsOf('lua'),
		note: 'scope and runtime from the project .luarc.json; documentSymbol outlines functions and file-level tables, not locals inside functions (workspaceSymbol finds those by name)',
		watch: ['.lua'],
		server: () => ({ command: 'lua-language-server', args: [] }),
		results: { 'textDocument/documentSymbol': luaOutline },
		// Without a .luarc.json bounding the workspace, LuaLS scans every file under the root.
		present: (root) => existsSync(join(root, '.luarc.json')) || existsSync(join(root, '.luarc.jsonc')),
		available: () => onPath('lua-language-server')
	}
};

// The git toplevel owning `dir` (dir itself included): the nearest directory
// holding a `.git` directory (a main checkout) or a `.git` file pointing into a
// repo's worktrees/ (a linked worktree). A submodule's `.git` file points into
// modules/, so a submodule belongs to its superproject. null outside a repo.
// The path keeps the caller's spelling.
export function gitRoot(dir) {
	for (let d = dir; ; d = dirname(d)) {
		const git = join(d, '.git');
		try {
			const st = statSync(git, { throwIfNoEntry: false });
			if (st?.isDirectory() || (st?.isFile() && /^gitdir:.*[\\/]worktrees[\\/]/.test(readFileSync(git, 'utf8')))) return d;
		} catch {} // unreadable: keep walking up
		if (dirname(d) === d) return null;
	}
}

// LuaLS's documentSymbol lists every local, parameter and if/for block of every
// function body: thousands of entries in a large file. The outline keeps what
// navigation needs, with ranges intact:
// - every symbol at file level and in table constructors at file level
//   (functions, methods, variables, named fields; not array items `[1]`);
// - inside a function body, only named functions (nested helpers, not the
//   anonymous callbacks LuaLS names after the call they're passed to, detail "-> ...");
// - control blocks (kind Package: if/for/do) vanish, their kept contents hoisted.
// A flat SymbolInformation[] answer (no `children`) passes through unchanged.
const LUA_FUNCTION_KINDS = new Set([6, 12]); // Method, Function
const LUA_BLOCK_KIND = 4;
export function luaOutline(symbols) {
	if (!Array.isArray(symbols) || symbols.some((s) => !s.range)) return symbols;
	const walk = (list, inFunction) =>
		(list ?? []).flatMap((s) => {
			const fn = LUA_FUNCTION_KINDS.has(s.kind) && !s.detail?.startsWith('->');
			const keep = fn || (!inFunction && s.kind !== LUA_BLOCK_KIND && !s.name.startsWith('['));
			const children = walk(s.children, inFunction || LUA_FUNCTION_KINDS.has(s.kind));
			return keep ? [{ ...s, children }] : children;
		});
	return walk(symbols, false);
}

// Node tools come from the project's own node_modules first, then npm's global
// install folder.
const resolveFrom = (dirs, request) => {
	try {
		return createRequire(import.meta.url).resolve(request, { paths: dirs.filter(Boolean) });
	} catch {
		return null;
	}
};

// npm's global install folder, as npm's own config resolves it: this covers the
// Windows installer's %AppData%\npm, a custom prefix and version managers.
// `npm root -g` can't be read: all of npm 11's output goes through
// @npmcli/redact's redactLog, which prints every UUID-like path segment as
// `***` (its lib/index.js; the logging docs list only passwords and tokens, and
// there is no opt-out), so a prefix under Claude's temp folder comes back as a
// folder that doesn't exist. Instead npm runs a command in the environment it
// gives package.json scripts (npm-exec docs, `--call`), where its config code
// exports the global prefix as npm_config_global_prefix (@npmcli/config
// lib/set-envs.js, npm 7 and later). The folder under the prefix is the npm
// folders docs' rule. A folder that doesn't exist is a failed lookup.
// The manager asks once at its start (askNpm). Asking takes about a second, too
// slow for every Grep hook, so the hooks reuse the manager's last good answer
// from a file, kept for one key: what npm derives it from (the node binary, the
// prefix setting and the user's .npmrc).
let npmGlobal; // { dir } or { error }
const npmKey = () => {
	const userConfig = process.env.npm_config_userconfig || join(homedir(), '.npmrc');
	return [process.execPath, process.env.npm_config_prefix ?? '', statSync(userConfig, { throwIfNoEntry: false })?.mtimeMs ?? 0].join('|');
};
const npmCache = () => join(dataDir(), 'lsp-kit-npm-root.json');

export function askNpm() {
	let prefix = '';
	try {
		// windowsHide: run from the console-less manager, it would flash a console window.
		prefix = execSync('npm exec --call "node -p process.env.npm_config_global_prefix"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
	} catch {} // no npm: the answer is empty
	const dir = prefix && join(prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules');
	if (!dir || !existsSync(dir)) return (npmGlobal = { error: `npm's global folder ${dir ? `${dir} doesn't exist` : 'is unknown (npm gave no answer)'}` });
	try {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(npmCache(), JSON.stringify({ key: npmKey(), dir }));
	} catch {} // unwritable: the hooks ask npm themselves
	return (npmGlobal = { dir });
}

function globalModules() {
	if (!npmGlobal) {
		let cached;
		try {
			cached = JSON.parse(readFileSync(npmCache(), 'utf8'));
		} catch {} // none yet
		npmGlobal = cached?.key === npmKey() && existsSync(cached.dir) ? { dir: cached.dir } : askNpm();
	}
	return npmGlobal;
}

const svelteServer = (root) => resolveFrom([root], 'svelte-language-server/bin/server.js') ?? resolveFrom([globalModules().dir], 'svelte-language-server/bin/server.js');

const PLATFORM_PACKAGE = `@typescript/typescript-${process.platform}-${process.arch}`;
const major = (version) => Number(version?.split('.')[0]);
const packageAt = (dir, name) => {
	const json = resolveFrom([dir], `${name}/package.json`);
	return json && { dir: dirname(json), version: JSON.parse(readFileSync(json, 'utf8')).version };
};

// The first TypeScript 7 or newer among the project's `typescript`, its
// `@typescript/native` (Microsoft's side-by-side alias of typescript@7 beside a
// TS 6 `typescript`, per the TS 7.0 announcement) and the global `typescript`.
// A project still on TS 6 (Svelte's tooling needs it) is served by the global
// TS 7, with TS 7's semantics. The `tsc` bin is a node wrapper that runs the
// native compiler as its child, so stopping it could orphan the server (as with
// rustup's proxy): the platform package's binary is started directly, found as
// typescript/lib/getExePath.js finds it.
function typescript7(root) {
	const ts7 = (p) => (major(p?.version) >= 7 ? p : null);
	const project = packageAt(root, 'typescript');
	const found = ts7(project) ?? ts7(packageAt(root, '@typescript/native')) ?? ts7(packageAt(globalModules().dir, 'typescript'));
	if (!found) return null;
	const native = resolveFrom([found.dir], `${PLATFORM_PACKAGE}/package.json`);
	return { ...found, exe: native && join(dirname(native), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc'), project: project?.version };
}

function typescriptServer(root) {
	const ts = typescript7(root);
	if (!ts) throw new Error(`TypeScript 7 not found in the project${npmGlobal.error ? ` (and ${npmGlobal.error})` : ` or ${npmGlobal.dir}`}: npm install -g typescript@7`);
	if (!ts.exe) throw new Error(`TypeScript ${ts.version} in ${ts.dir} lacks its platform package ${PLATFORM_PACKAGE}`);
	const note = major(ts.project) < 7 ? `the project has TypeScript ${ts.project}; TypeScript ${ts.version} from ${ts.dir} serves it` : undefined;
	return { command: ts.exe, args: ['--lsp', '--stdio'], note };
}

// The topmost Cargo.toml of every subtree (a workspace manifest covers its
// members), stopping once `max` are found.
export function cargoManifests(dir, max = Infinity, found = []) {
	const manifest = join(dir, 'Cargo.toml');
	if (existsSync(manifest)) {
		found.push(manifest);
		return found;
	}
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const e of entries) {
		if (found.length >= max) break;
		if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) cargoManifests(join(dir, e.name), max, found);
	}
	return found;
}

// Under rustup, `rust-analyzer` on PATH is rustup's proxy, which runs the
// toolchain's server as its own child: stopping the proxy can orphan the real
// server. The toolchain binary is started directly instead, resolved in the
// server's root on every start, so a checkout pinned by its own
// rust-toolchain.toml gets that toolchain's server. Without rustup, the PATH
// binary is the server itself.
function rustAnalyzer(root) {
	try {
		// windowsHide: run from the console-less manager, it would flash a console window.
		return execFileSync('rustup', ['which', 'rust-analyzer'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
	} catch (e) {
		if (e.code === 'ENOENT') return 'rust-analyzer';
		throw new Error(`rustup which rust-analyzer failed: ${e.stderr?.trim() || e.message}`);
	}
}

function onPath(command) {
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
	return (process.env.PATH ?? '').split(delimiter).some((d) => d && exts.some((x) => existsSync(join(d, command + x))));
}
