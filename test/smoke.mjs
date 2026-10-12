// Drives the lsp-kit proxy like Claude Code's client and reports timing per
// request plus the server start/stop log, on a private manager it stops at the end.
//
//   node test/smoke.mjs <language> <workspaceRoot> <op> <file:line:col> [<file:line:col> ...]
//
// op is an LSP method suffix: hover | references | documentSymbol | definition.
// Files may sit in git worktrees under the root; each is a folder of its own
// (watch the "server #n for <root>" and "adds <root>" lines).
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGES } from '../plugins/lsp-kit/languages.mjs';
import { killManager, log, startProxy, wait } from './client.mjs';

const [language, root, op, ...targets] = process.argv.slice(2);
const client = startProxy(language, root);

const describe = (r) =>
	r?.error ? `ERROR ${r.error}` : Array.isArray(r) ? `${r.length} results` : r?.contents ? JSON.stringify(r.contents).slice(0, 90) : JSON.stringify(r)?.slice(0, 90);

const init = await client.initialize(resolve(root));
log(init?.error ? `initialize ERROR ${init.error}` : `initialized (${Object.keys(init?.capabilities ?? {}).length} capabilities)`);
if (init?.error) process.exit(1);

const method = { hover: 'textDocument/hover', references: 'textDocument/references', documentSymbol: 'textDocument/documentSymbol', definition: 'textDocument/definition' }[op];
for (const target of targets) {
	const [file, line, col] = target.split(/:(?=\d)/);
	const path = resolve(root, file);
	const uri = pathToFileURL(path).href;
	client.open(uri, LANGUAGES[language].extensionToLanguage[extname(path)], readFileSync(path, 'utf8'));
	const params = { textDocument: { uri }, position: { line: +line - 1, character: +col - 1 }, context: { includeDeclaration: false } };
	// Servers answer empty while indexing; retry until a real answer or 90 s.
	let r;
	const start = Date.now();
	do {
		r = await client.req(method, params);
		if (r?.error || (Array.isArray(r) ? r.length : r)) break;
		await wait(2000);
	} while (Date.now() - start < 90000);
	log(`${op} ${file}:${line}:${col} -> ${describe(r)} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}
await client.close();
killManager(client.manager);
