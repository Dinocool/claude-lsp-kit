// A language server for the tests that a real one can't be made to act like:
// it never answers textDocument/hover (a request stays in flight), and it and
// the helper process it starts outlive the end of their input, as a hung
// server and its helpers would. The helper is detached: like rust-analyzer's
// proc-macro servers it is in no job object, so on Windows it outlives the
// stub's death with its manager's job (libuv). It starts only with
// STUB_HELPER set; its pid goes to stderr, which the manager logs. Every other
// request is answered null; `exit` ends the stub.
import { spawn } from 'node:child_process';
import { frame, readFrames } from '../plugins/lsp-kit/rpc.mjs';

if (process.env.STUB_HELPER) {
	const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore', windowsHide: true });
	process.stderr.write(`helper pid ${helper.pid}\n`);
}
setInterval(() => {}, 1 << 30);
process.stdout.on('error', () => {}); // its manager is gone
readFrames(process.stdin, (msg) => {
	if (msg.method === 'exit') process.exit(0);
	if (msg.id == null || !msg.method || msg.method === 'textDocument/hover') return;
	process.stdout.write(frame({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? { capabilities: { hoverProvider: true } } : null }));
});
