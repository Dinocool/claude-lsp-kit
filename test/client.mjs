// The tests' LSP client: drives the proxy like Claude Code does (capabilities {},
// every server->client request answered null) and keeps the proxy's lsp-kit log.
import { execSync, spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const t0 = Date.now();
export const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
export const check = (ok, what) => (log(`${ok ? 'PASS' : 'FAIL'} ${what}`), ok || failed++);
export const finish = () => (log(failed ? `${failed} FAILED` : 'all passed'), process.exit(failed ? 1 : 0));

export const alive = (pid) => {
	try {
		return process.kill(pid, 0);
	} catch (e) {
		return e.code === 'EPERM';
	}
};
export const processPath = (pid) =>
	process.platform === 'win32'
		? execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).Path"`).toString().trim()
		: readlinkSync(`/proc/${pid}/exe`);

export function startProxy(language, cwd, env = {}) {
	const proxy = spawn(process.execPath, [fileURLToPath(new URL('../plugins/lsp-kit/proxy.mjs', import.meta.url)), language], {
		cwd,
		env: { ...process.env, ...env }
	});
	const waits = new Map();
	const client = { proxy, stderr: [], onNotification: () => {} };
	client.exited = new Promise((res) => proxy.on('exit', res));
	client.exited.then((code) => waits.forEach((res) => res({ error: `proxy exited (code ${code})` })));
	proxy.stderr.on('data', (d) => d.toString().split('\n').filter((l) => l.startsWith('lsp-kit')).forEach((l) => (client.stderr.push(l), log(l))));
	client.write = (m) => {
		const b = Buffer.from(JSON.stringify(m));
		proxy.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b]));
	};
	client.notify = (method, params) => client.write({ jsonrpc: '2.0', method, params });
	let id = 0;
	client.req = (method, params) =>
		proxy.exitCode !== null
			? Promise.resolve({ error: `proxy exited (code ${proxy.exitCode})` })
			: new Promise((res) => (waits.set(++id, res), client.write({ jsonrpc: '2.0', id, method, params })));
	let buf = Buffer.alloc(0);
	proxy.stdout.on('data', (d) => {
		buf = Buffer.concat([buf, d]);
		for (;;) {
			const h = buf.indexOf('\r\n\r\n');
			if (h < 0) return;
			const n = +/Content-Length: (\d+)/.exec(buf.subarray(0, h))[1];
			if (buf.length < h + 4 + n) return;
			const m = JSON.parse(buf.subarray(h + 4, h + 4 + n));
			buf = buf.subarray(h + 4 + n);
			if (m.id != null && !m.method && waits.has(m.id)) waits.get(m.id)(m.error ? { error: m.error.message } : m.result);
			else if (m.id != null && m.method) client.write({ jsonrpc: '2.0', id: m.id, result: null });
			else if (m.method) client.onNotification(m);
		}
	});
	client.initialize = async (root) => {
		const uri = pathToFileURL(root).href;
		const r = await client.req('initialize', { processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: basename(root) }], capabilities: {} });
		client.notify('initialized', {});
		return r;
	};
	client.open = (uri, languageId, text) => client.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
	// The pid of the newest server the proxy started for `root`, from its start log line.
	client.pidFor = (root) =>
		Number(client.stderr.filter((l) => l.includes(` for ${root} (`)).map((l) => /pid (\d+)\)$/.exec(l)?.[1]).at(-1));
	client.pids = () => client.stderr.map((l) => Number(/ live, pid (\d+)\)$/.exec(l)?.[1])).filter(Boolean);
	client.close = async () => {
		await client.req('shutdown', null);
		client.notify('exit', null);
		return client.exited;
	};
	return client;
}
