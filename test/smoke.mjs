// Drives the lsp-kit proxy like Claude Code's client (capabilities {}) and
// reports timing per request plus the proxy's server start/stop log.
//
//   node test/smoke.mjs <language> <workspaceRoot> <op> <file:line:col> [<file:line:col> ...]
//
// op is an LSP method suffix: hover | references | documentSymbol | definition.
// Files may sit in git worktrees under the root; each should start its own
// server (watch the "server #n for <root>" lines), capped by the proxy.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [language, root, op, ...targets] = process.argv.slice(2);
const proxy = fileURLToPath(new URL('../plugins/lsp-kit/proxy.mjs', import.meta.url));
const t0 = Date.now();
const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);

const child = spawn(process.execPath, [proxy, language], { cwd: root });
child.stderr.on('data', (d) => d.toString().split('\n').filter((l) => l.startsWith('lsp-kit')).forEach((l) => log(l)));
let buf = Buffer.alloc(0);
let id = 0;
const waits = new Map();
const write = (m) => {
	const b = Buffer.from(JSON.stringify(m));
	child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b]));
};
const req = (method, params) => new Promise((res) => (waits.set(++id, res), write({ jsonrpc: '2.0', id, method, params })));
child.stdout.on('data', (d) => {
	buf = Buffer.concat([buf, d]);
	for (;;) {
		const h = buf.indexOf('\r\n\r\n');
		if (h < 0) return;
		const n = +/Content-Length: (\d+)/.exec(buf.subarray(0, h))[1];
		if (buf.length < h + 4 + n) return;
		const m = JSON.parse(buf.subarray(h + 4, h + 4 + n));
		buf = buf.subarray(h + 4 + n);
		if (m.id != null && !m.method && waits.has(m.id)) waits.get(m.id)(m.error ? { error: m.error.message } : m.result);
		else if (m.id != null && m.method) write({ jsonrpc: '2.0', id: m.id, result: null }); // like a client that ACKs requests
	}
});

const describe = (r) =>
	r?.error ? `ERROR ${r.error}` : Array.isArray(r) ? `${r.length} results` : r?.contents ? JSON.stringify(r.contents).slice(0, 90) : JSON.stringify(r)?.slice(0, 90);

const rootUri = pathToFileURL(resolve(root)).href;
const init = await req('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'root' }], capabilities: {} });
log(init?.error ? `initialize ERROR ${init.error}` : `initialized (${Object.keys(init?.capabilities ?? {}).length} capabilities)`);
if (init?.error) process.exit(1);
write({ jsonrpc: '2.0', method: 'initialized', params: {} });

const method = { hover: 'textDocument/hover', references: 'textDocument/references', documentSymbol: 'textDocument/documentSymbol', definition: 'textDocument/definition' }[op];
for (const target of targets) {
	const [file, line, col] = target.split(/:(?=\d)/);
	const path = resolve(root, file);
	const uri = pathToFileURL(path).href;
	write({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: language, version: 1, text: readFileSync(path, 'utf8') } } });
	const params = { textDocument: { uri }, position: { line: +line - 1, character: +col - 1 }, context: { includeDeclaration: false } };
	// Servers answer empty while indexing; retry until a real answer or 90 s.
	let r;
	const start = Date.now();
	do {
		r = await req(method, params);
		if (r?.error || (Array.isArray(r) ? r.length : r)) break;
		await new Promise((res) => setTimeout(res, 2000));
	} while (Date.now() - start < 90000);
	log(`${op} ${file}:${line}:${col} -> ${describe(r)} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}
await req('shutdown', null);
write({ jsonrpc: '2.0', method: 'exit', params: null });
setTimeout(() => process.exit(0), 3000);
