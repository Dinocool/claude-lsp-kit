// The languages lsp-kit serves. The proxy reads `server`, `languageId`,
// `watch`, `initializationOptions` and `results` (per-method response
// rewrites); the hooks read `name`, `extensions`, `note`, `present` and
// `available`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

const SVELTE_CONFIGS = ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.cjs', 'svelte.config.ts'];
const SKIP_DIRS = new Set(['target', 'node_modules']);

export const LANGUAGES = {
	svelte: {
		name: 'Svelte',
		extensions: ['.svelte'],
		languageId: 'svelte',
		note: 'TypeScript-aware: definitions and references include the .ts/.js files a component imports',
		watch: ['.ts', '.js', '.mts', '.mjs', '.cjs', '.cts', '.json', '.svelte'],
		server: (root) => {
			const path = svelteServer(root);
			if (!path) throw new Error('svelte-language-server not found (npm install -g svelte-language-server)');
			return { command: process.execPath, args: [path, '--stdio'] };
		},
		present: (root) => SVELTE_CONFIGS.some((f) => existsSync(join(root, f))),
		available: (root) => !!svelteServer(root)
	},
	rust: {
		name: 'Rust',
		extensions: ['.rs'],
		languageId: 'rust',
		note: 'every crate in the repo, including nested ones; answers come back empty for ~15 s while it indexes, so retry an empty first result',
		watch: ['.rs', '.toml'],
		server: () => ({ command: rustAnalyzer(), args: [] }),
		// rust-analyzer alone only finds Cargo.toml at its root and one level down.
		initializationOptions: (root) => ({ linkedProjects: cargoManifests(root) }),
		present: (root) => cargoManifests(root, 1).length > 0,
		available: () => onPath('rust-analyzer')
	},
	lua: {
		name: 'Lua',
		extensions: ['.lua'],
		languageId: 'lua',
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

// The project's own svelte-language-server first, then the global install next to
// this node binary (Windows: <prefix>/node_modules, unix: <prefix>/lib/node_modules).
function svelteServer(root) {
	const nodeDir = dirname(process.execPath);
	try {
		return createRequire(import.meta.url).resolve('svelte-language-server/bin/server.js', {
			paths: [root, join(nodeDir, 'node_modules'), join(nodeDir, '..', 'lib', 'node_modules')]
		});
	} catch {
		return null;
	}
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
// server. The toolchain binary is started directly instead, resolved once per
// process. Without rustup, the PATH binary is the server itself.
let rustAnalyzerPath;
function rustAnalyzer() {
	if (rustAnalyzerPath) return rustAnalyzerPath;
	try {
		rustAnalyzerPath = execFileSync('rustup', ['which', 'rust-analyzer'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (e) {
		if (e.code !== 'ENOENT') throw new Error(`rustup which rust-analyzer failed: ${e.stderr?.trim() || e.message}`);
		rustAnalyzerPath = 'rust-analyzer';
	}
	return rustAnalyzerPath;
}

function onPath(command) {
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
	return (process.env.PATH ?? '').split(delimiter).some((d) => d && exts.some((x) => existsSync(join(d, command + x))));
}
