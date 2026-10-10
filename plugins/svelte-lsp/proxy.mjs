// Stdio proxy between Claude Code's LSP client and svelte-language-server.
//
// Why it exists: Claude Code's client does not advertise
// `workspace.didChangeWatchedFiles`, so the server falls back to a chokidar
// watcher over the whole workspace (only .git/node_modules ignored). That
// includes .claude/worktrees (full repo copies) and any large data folders:
// on Windows the crawl starves the event loop for minutes and every request
// times out. The proxy
//   - advertises the capability on `initialize` (no fallback watcher),
//   - answers the server's watched-files registration itself,
//   - feeds file changes from ONE native recursive fs.watch per workspace root,
//     skipping node_modules and dot-directories other than .svelte-kit,
//   - spawns the server with this node binary (no `cmd /c` shim on Windows).
// Everything else passes through byte-for-byte.
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WATCHED_FILES = 'workspace/didChangeWatchedFiles';
const WATCH_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs', '.cjs', '.cts', '.json', '.svelte']);
const FILE_CHANGE = { Created: 1, Changed: 2, Deleted: 3 };

// The project's own copy wins (normal module resolution), then the global install
// next to this node binary (Windows: <prefix>/node_modules, unix: <prefix>/lib/node_modules).
const nodeDir = dirname(process.execPath);
const serverPath = createRequire(import.meta.url).resolve('svelte-language-server/bin/server.js', {
	paths: [process.cwd(), join(nodeDir, 'node_modules'), join(nodeDir, '..', 'lib', 'node_modules')]
});
const server = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
server.on('exit', (code) => process.exit(code ?? 0));
process.stdin.on('end', () => server.kill());

const frame = (msg) => {
	const body = Buffer.from(JSON.stringify(msg), 'utf8');
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
};

// Splits an LSP byte stream into messages; onMessage returns the bytes to forward
// (the raw frame, a rewritten frame, or null to swallow it).
function pipeFrames(input, output, onMessage) {
	let buf = Buffer.alloc(0);
	input.on('data', (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			const headerEnd = buf.indexOf('\r\n\r\n');
			if (headerEnd < 0) return;
			const length = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString('ascii'))?.[1]);
			const end = headerEnd + 4 + length;
			if (buf.length < end) return;
			const raw = buf.subarray(0, end);
			const out = onMessage(JSON.parse(buf.subarray(headerEnd + 4, end).toString('utf8')), raw);
			buf = buf.subarray(end);
			if (out) output.write(out);
		}
	});
}

pipeFrames(process.stdin, server.stdin, (msg, raw) => {
	if (msg.method !== 'initialize') return raw;
	const params = msg.params ?? {};
	params.capabilities ??= {};
	params.capabilities.workspace ??= {};
	params.capabilities.workspace.didChangeWatchedFiles = { dynamicRegistration: true };
	const roots = params.workspaceFolders?.map((f) => f.uri) ?? [params.rootUri ?? pathToFileURL(process.cwd()).href];
	for (const uri of roots) watchRoot(fileURLToPath(uri));
	return frame({ ...msg, params });
});

pipeFrames(server.stdout, process.stdout, (msg, raw) => {
	if (msg.method !== 'client/registerCapability') return raw;
	const registrations = msg.params.registrations.filter((r) => r.method !== WATCHED_FILES);
	if (registrations.length === msg.params.registrations.length) return raw;
	if (registrations.length) return frame({ ...msg, params: { registrations } });
	server.stdin.write(frame({ jsonrpc: '2.0', id: msg.id, result: null }));
	return null;
});

let pending = new Map();
let flushTimer = null;
function watchRoot(root) {
	watch(root, { recursive: true }, (event, filename) => {
		if (!filename || !WATCH_EXTENSIONS.has(extname(filename))) return;
		const dirs = filename.split(/[\\/]/).slice(0, -1);
		if (dirs.some((d) => d === 'node_modules' || (d.startsWith('.') && d !== '.svelte-kit'))) return;
		const path = join(root, filename);
		const type = event === 'change' ? FILE_CHANGE.Changed : existsSync(path) ? FILE_CHANGE.Created : FILE_CHANGE.Deleted;
		pending.set(path, type);
		flushTimer ??= setTimeout(flush, 50);
	}).on('error', (e) => process.stderr.write(`svelte-lsp proxy: watch ${root} failed: ${e.message}\n`));
}
function flush() {
	const changes = [...pending].map(([path, type]) => ({ uri: pathToFileURL(path).href, type }));
	pending = new Map();
	flushTimer = null;
	server.stdin.write(frame({ jsonrpc: '2.0', method: WATCHED_FILES, params: { changes } }));
}
