// A language server for the tests that a real one can't be made to act like:
// it never answers textDocument/hover on the first line (a request stays in
// flight) unless the file STUB_ANSWER_AFTER names exists, until `shutdown`
// fails it late; it and the helper process it starts outlive the end of their
// input, as a hung server and its helpers would. The helper is detached: like rust-analyzer's
// proc-macro servers it is in no job object, so on Windows it outlives the
// stub's death with its manager's job (libuv). It starts only with
// STUB_HELPER set; its pid goes to stderr, which the manager logs. Every other
// request is answered null; `exit` ends the stub.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { frame, readFrames } from '../plugins/lsp-kit/rpc.mjs';

if (process.env.STUB_HELPER) {
	const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore', windowsHide: true });
	process.stderr.write(`helper pid ${helper.pid}\n`);
}
setInterval(() => {}, 1 << 30);
process.stdout.on('error', () => {}); // its manager is gone
const held = [];
readFrames(process.stdin, (msg) => {
	if (msg.method === 'exit') process.exit(0);
	if (msg.id == null || !msg.method) return;
	if (msg.method === 'textDocument/hover' && !msg.params?.position?.line && !existsSync(process.env.STUB_ANSWER_AFTER ?? '')) return void held.push(msg.id);
	if (msg.method === 'shutdown') for (const id of held.splice(0)) process.stdout.write(frame({ jsonrpc: '2.0', id, error: { code: -32603, message: 'shutting down' } }));
	process.stdout.write(frame({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? { capabilities: { hoverProvider: true } } : null }));
});
