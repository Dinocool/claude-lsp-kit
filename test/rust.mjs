// rust-analyzer runs as the proxy's own child, not behind rustup's proxy binary
// (killing that one could orphan the real server), answers, and exits with the
// proxy at the end of stdin. Under rustup, a worktree pinned to another
// installed toolchain by its rust-toolchain.toml gets that toolchain's server.
// Builds a throwaway crate under <dir>.
// Usage: node test/rust.mjs <scratchDir>   (needs rust-analyzer; skips without it)
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGES } from '../plugins/lsp-kit/languages.mjs';
import { alive, check, finish, log, processPath, startProxy, wait } from './client.mjs';

if (!LANGUAGES.rust.available()) {
	log('SKIP rust-analyzer is not installed');
	process.exit(0);
}
rmSync(process.argv[2], { recursive: true, force: true });
const repo = join(process.argv[2], 'crate');
mkdirSync(join(repo, 'src'), { recursive: true });
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
writeFileSync(join(repo, 'Cargo.toml'), '[package]\nname = "kit"\nversion = "0.1.0"\nedition = "2021"\n');
const text = 'fn helper(x: u32) -> u32 { x }\nfn main() { helper(1); }\n';
writeFileSync(join(repo, 'src', 'main.rs'), text);
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');
// The session reaches the crate through a junction (a symlink off Windows): a
// spelling that isn't the canonical path, like an 8.3 short name or a subst drive.
const root = join(process.argv[2], 'link');
symlinkSync(realpathSync.native(repo), root, 'junction');

const client = startProxy('rust', root);
await client.initialize(root);
const [pid] = client.pids();
const path = processPath(pid);
check(/^rust-analyzer(\.exe)?$/i.test(basename(path)), `the proxy holds rust-analyzer itself (pid ${pid} is ${path})`);

// Go to definition of `helper` from its call in main, retried while rust-analyzer indexes.
const definitionIn = async (dir) => {
	const uri = pathToFileURL(join(dir, 'src', 'main.rs')).href;
	client.open(uri, 'rust', text);
	let r;
	for (let i = 0; i < 60; i++) {
		r = await client.req('textDocument/definition', { textDocument: { uri }, position: { line: 1, character: 12 } });
		if (r?.error || r?.length) break;
		await wait(1000);
	}
	return r;
};
const definition = await definitionIn(root);
check(definition?.some?.((d) => (d.range ?? d.targetRange)?.start.line === 0), `goToDefinition through ${root} finds helper: ${JSON.stringify(definition)?.slice(0, 120)}`);

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
	const wt = join(root, 'pinned');
	writeFileSync(join(wt, 'rust-toolchain.toml'), `[toolchain]\nchannel = "${other}"\n`);
	let expected;
	try {
		expected = execFileSync('rustup', ['which', '--toolchain', other, 'rust-analyzer'], { encoding: 'utf8', stdio: 'pipe' }).trim();
	} catch {}
	const r = await definitionIn(wt);
	if (expected) check(processPath(client.pidFor(wt)) === expected, `the worktree pinned to ${other} runs ${expected}`);
	else check(/could not start: .*rust-analyzer.*/.test(r?.error) && r.error.includes(other), `the worktree pinned to ${other} (no rust-analyzer there) answers rustup's error: ${r?.error}`);
}

const pids = client.pids();
client.proxy.stdin.end();
await client.exited;
check(pids.every((p) => !alive(p)), `end of stdin: every rust-analyzer (${pids.join(', ')}) exits with the proxy`);
finish();
