// rust-analyzer runs as the proxy's own child, not behind rustup's proxy binary
// (killing that one could orphan the real server), answers, and exits with the
// proxy at the end of stdin. Under rustup, a worktree pinned to another
// installed toolchain by its rust-toolchain.toml gets that toolchain's server.
// Builds a throwaway crate under <dir>.
// Usage: node test/rust.mjs <scratchDir>   (needs rust-analyzer; skips without it)
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGES } from '../plugins/lsp-kit/languages.mjs';
import { alive, check, finish, log, processPath, startProxy, wait } from './client.mjs';

if (!LANGUAGES.rust.available()) {
	log('SKIP rust-analyzer is not installed');
	process.exit(0);
}
rmSync(process.argv[2], { recursive: true, force: true });
mkdirSync(join(process.argv[2], 'crate', 'src'), { recursive: true });
const repo = realpathSync.native(join(process.argv[2], 'crate'));
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
writeFileSync(join(repo, 'Cargo.toml'), '[package]\nname = "kit"\nversion = "0.1.0"\nedition = "2021"\n');
const text = 'fn helper(x: u32) -> u32 { x }\nfn main() { helper(1); }\n';
writeFileSync(join(repo, 'src', 'main.rs'), text);
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');

const client = startProxy('rust', repo);
await client.initialize(repo);
const pid = client.pidFor(repo);
const path = processPath(pid);
check(/^rust-analyzer(\.exe)?$/i.test(basename(path)), `the proxy holds rust-analyzer itself (pid ${pid} is ${path})`);

const symbolsOf = async (dir) => {
	const uri = pathToFileURL(join(dir, 'src', 'main.rs')).href;
	client.open(uri, 'rust', text);
	let r;
	for (let i = 0; i < 60; i++) {
		r = await client.req('textDocument/documentSymbol', { textDocument: { uri } });
		if (r?.error || r?.length) break;
		await wait(1000); // empty while indexing
	}
	return r;
};
const symbols = await symbolsOf(repo);
check(Array.isArray(symbols) && symbols.some((s) => s.name === 'helper'), 'rust-analyzer answers documentSymbol');

// A worktree pinned to another installed toolchain. Only installed ones: rustup
// installs a pinned toolchain it doesn't have the moment anything asks.
let rustup = null;
try {
	rustup = execFileSync('rustup', ['toolchain', 'list'], { encoding: 'utf8' });
} catch {}
const other = rustup?.split('\n').find((l) => l.trim() && !l.includes('default'))?.split(' ')[0];
if (!other) log(`SKIP pinned toolchain: ${rustup ? 'only one toolchain installed' : 'no rustup'}`);
else {
	sh('git worktree add -q pinned');
	const wt = realpathSync.native(join(repo, 'pinned'));
	writeFileSync(join(wt, 'rust-toolchain.toml'), `[toolchain]\nchannel = "${other}"\n`);
	let expected;
	try {
		expected = execFileSync('rustup', ['which', '--toolchain', other, 'rust-analyzer'], { encoding: 'utf8', stdio: 'pipe' }).trim();
	} catch {}
	const r = await symbolsOf(wt);
	if (expected) check(processPath(client.pidFor(wt)) === expected, `the worktree pinned to ${other} runs ${expected}`);
	else check(/could not start: .*rust-analyzer.*/.test(r?.error) && r.error.includes(other), `the worktree pinned to ${other} (no rust-analyzer there) answers rustup's error: ${r?.error}`);
}

const pids = client.pids();
client.proxy.stdin.end();
await client.exited;
check(pids.every((p) => !alive(p)), `end of stdin: every rust-analyzer (${pids.join(', ')}) exits with the proxy`);
finish();
