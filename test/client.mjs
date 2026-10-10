// The tests' LSP client: drives the proxy like Claude Code does (capabilities {},
// every server->client request answered null) and keeps the lsp-kit log lines
// the proxy relays from its manager.
import { execSync, spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const t0 = Date.now();
export const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Every proxy joins a private manager (LSP_KIT_PIPE), never the machine's real
// one; finish() kills each manager the test's proxies joined, and with it its servers.
let pipes = 0;
export const privatePipe = () => `lsp-kit-test-${process.pid}-${++pipes}`;
const managers = new Set();
export const killManager = (pid) => {
	if (!alive(pid)) return false;
	process.kill(pid);
	return true;
};

let failed = 0;
export const check = (ok, what) => (log(`${ok ? 'PASS' : 'FAIL'} ${what}`), ok || failed++);
export const finish = () => {
	managers.forEach(killManager);
	log(failed ? `${failed} FAILED` : 'all passed');
	process.exit(failed ? 1 : 0);
};

export const alive = (pid) => {
	try {
		return process.kill(pid, 0);
	} catch (e) {
		return e.code === 'EPERM';
	}
};
// The pids of every manager process running this checkout's manager.mjs.
const managerScript = fileURLToPath(new URL('../plugins/lsp-kit/manager.mjs', import.meta.url));
export const managerProcesses = () =>
	(process.platform === 'win32'
		? execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }"`)
		: execSync('ps -eo pid=,args=')
	)
		.toString()
		.split('\n')
		.filter((l) => l.includes(managerScript))
		.map((l) => Number(l.trim().split(' ')[0]));
export const processPath = (pid) =>
	process.platform === 'win32'
		? execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).Path"`).toString().trim()
		: readlinkSync(`/proc/${pid}/exe`);

// A proxy for `language` in `cwd`, on the manager named env.LSP_KIT_PIPE (pass
// the same name to share one manager); `name` labels its log lines.
export function startProxy(language, cwd, { name, ...env } = {}) {
	const proxy = spawn(process.execPath, [fileURLToPath(new URL('../plugins/lsp-kit/proxy.mjs', import.meta.url)), language], {
		cwd,
		env: { ...process.env, LSP_KIT_PIPE: privatePipe(), ...env }
	});
	const waits = new Map();
	const client = { proxy, stderr: [], onNotification: () => {}, name: name ?? `proxy ${proxy.pid}` };
	client.exited = new Promise((res) => proxy.on('exit', res));
	client.exited.then((code) => waits.forEach((res) => res({ error: `proxy exited (code ${code})` })));
	proxy.stderr.on('data', (d) =>
		d
			.toString()
			.split('\n')
			.filter((l) => l.startsWith('lsp-kit'))
			.forEach((l) => {
				client.stderr.push(l);
				log(`[${client.name}] ${l}`);
				const manager = Number(/joined manager pid (\d+)$/.exec(l)?.[1]);
				if (manager) managers.add((client.manager = manager));
			})
	);
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
