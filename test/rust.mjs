// rust-analyzer runs as the proxy's own child, not behind rustup's proxy binary
// (killing that one could orphan the real server), answers, and exits with the
// proxy at the end of stdin. Builds a throwaway crate under <dir>.
// Usage: node test/rust.mjs <scratchDir>   (needs rust-analyzer; skips without it)
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGES } from '../plugins/lsp-kit/languages.mjs';
import { alive, check, finish, log, processName, startProxy, wait } from './client.mjs';

if (!LANGUAGES.rust.available()) {
	log('SKIP rust-analyzer is not installed');
	process.exit(0);
}
const repo = join(process.argv[2], 'crate');
rmSync(process.argv[2], { recursive: true, force: true });
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'Cargo.toml'), '[package]\nname = "kit"\nversion = "0.1.0"\nedition = "2021"\n');
const text = 'fn helper(x: u32) -> u32 { x }\nfn main() { helper(1); }\n';
writeFileSync(join(repo, 'src', 'main.rs'), text);
execSync('git init -q', { cwd: repo });

const client = startProxy('rust', repo);
await client.initialize(repo);
const pid = client.pidFor(repo);
const name = processName(pid);
check(/^rust-analyzer(\.exe)?$/i.test(name ?? ''), `the proxy holds rust-analyzer itself (pid ${pid} is ${name})`);

const uri = pathToFileURL(join(repo, 'src', 'main.rs')).href;
client.open(uri, 'rust', text);
let symbols;
for (let i = 0; i < 60; i++) {
	symbols = await client.req('textDocument/documentSymbol', { textDocument: { uri } });
	if (symbols?.error || symbols?.length) break;
	await wait(1000); // empty while indexing
}
check(Array.isArray(symbols) && symbols.some((s) => s.name === 'helper'), 'rust-analyzer answers documentSymbol');

client.proxy.stdin.end();
await client.exited;
check(!alive(pid), `end of stdin: rust-analyzer (pid ${pid}) exits with the proxy`);
finish();
