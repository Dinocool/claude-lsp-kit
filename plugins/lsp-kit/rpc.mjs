// What the per-session proxy and the machine-wide manager share: LSP framing,
// the manager's endpoint and the document key.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const frame = (msg) => {
	const body = Buffer.from(JSON.stringify(msg), 'utf8');
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
};

export function readFrames(input, onMessage) {
	let buf = Buffer.alloc(0);
	input.on('data', (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			const headerEnd = buf.indexOf('\r\n\r\n');
			if (headerEnd < 0) return;
			const end = headerEnd + 4 + Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString('ascii'))?.[1]);
			if (Number.isNaN(end)) {
				buf = buf.subarray(headerEnd + 4); // no Content-Length: drop the header block
				continue;
			}
			if (buf.length < end) return;
			const body = buf.subarray(headerEnd + 4, end).toString('utf8');
			buf = buf.subarray(end);
			let msg;
			try {
				msg = JSON.parse(body);
			} catch {
				process.stderr.write(`lsp-kit: dropped a malformed message: ${body.slice(0, 120)}\n`);
				continue;
			}
			onMessage(msg);
		}
	});
}

// The manager's protocol version is a digest of the code it runs, so a plugin
// update that changes the manager starts a new one beside the old (which ends
// once its sessions and servers are gone), and versions with the same manager
// code share it. A hand-bumped number would leave an updated session on the
// old manager whenever a release forgot the bump.
// languages.mjs reads its extension maps from plugin.json, so they count too
// (not the whole file: a version bump alone keeps the manager).
const MANAGER_CODE = ['manager.mjs', 'rpc.mjs', 'languages.mjs', 'processes.mjs'];
const protocol = () => {
	const hash = createHash('sha256');
	for (const file of MANAGER_CODE) hash.update(readFileSync(new URL(file, import.meta.url)));
	hash.update(JSON.stringify(JSON.parse(readFileSync(new URL('.claude-plugin/plugin.json', import.meta.url), 'utf8')).lspServers));
	return hash.digest('hex').slice(0, 12);
};

// One manager per machine, user and protocol: on Windows a named pipe, which
// only one process can listen on and which vanishes with its owner (Node net
// docs, "Identifying paths for IPC connections"); elsewhere a Unix socket in the
// plugin data dir. LSP_KIT_PIPE names a private manager (the tests use one each).
// The log sits in the plugin data dir (CLAUDE_PLUGIN_DATA, exported to LSP
// servers per the Claude Code plugins reference), else the temp dir.
export function endpoint() {
	const name = process.env.LSP_KIT_PIPE || `lsp-kit-${userInfo().username}-p${protocol()}`;
	const dir = dataDir();
	return { dir, path: pipePath(name, dir), log: join(dir, `${name}.log`) };
}
export const dataDir = () => process.env.CLAUDE_PLUGIN_DATA || tmpdir();
export const pipePath = (name, dir) => (process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(dir, `${name}.sock`));

// A document's key for matching one uri against another however they're
// spelled (a server may spell a uri differently in diagnostics than the
// client's didOpen: drive-letter case, percent-encoding): file uris by their
// path, case-folded where the file system is; anything else unchanged.
export const docKey = (uri) => {
	if (!uri?.startsWith('file:')) return uri;
	const path = fileURLToPath(uri);
	return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
};
