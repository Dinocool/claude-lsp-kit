// The languages lsp-kit serves. The proxy reads `server`, `languageId`,
// `watch` and `initializationOptions`; the hooks read `name`, `extensions`,
// `note`, `present` and `available`.
import { existsSync, readdirSync } from 'node:fs';
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
		note: 'every crate in the repo, including nested ones',
		watch: ['.rs', '.toml'],
		server: () => ({ command: 'rust-analyzer', args: [] }),
		// rust-analyzer alone only finds Cargo.toml at its root and one level down.
		initializationOptions: (root) => ({ linkedProjects: cargoManifests(root) }),
		present: (root) => cargoManifests(root, 1).length > 0,
		available: () => onPath('rust-analyzer')
	},
	lua: {
		name: 'Lua',
		extensions: ['.lua'],
		languageId: 'lua',
		note: 'scope and runtime from the project .luarc.json',
		watch: ['.lua'],
		server: () => ({ command: 'lua-language-server', args: [] }),
		// Without a .luarc.json bounding the workspace, LuaLS scans every file under the root.
		present: (root) => existsSync(join(root, '.luarc.json')) || existsSync(join(root, '.luarc.jsonc')),
		available: () => onPath('lua-language-server')
	}
};

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

function onPath(command) {
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
	return (process.env.PATH ?? '').split(delimiter).some((d) => d && exts.some((x) => existsSync(join(d, command + x))));
}
