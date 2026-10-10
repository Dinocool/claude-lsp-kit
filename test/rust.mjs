// rust-analyzer runs as the manager's own child, not behind rustup's proxy
// binary (killing that one could orphan the real server), answers, and exits
// with the manager. Under rustup, a worktree pinned to another
// installed toolchain by its rust-toolchain.toml gets that toolchain's server.
// rust-analyzer both pushes cargo check's errors and answers diagnostic pulls:
// a borrow error only cargo check finds stays published after an edit. Its
// refreshes after each file change, and the pulls they cause, don't keep an
// idle server alive.
// Builds a throwaway crate under <dir>.
// Usage: node test/rust.mjs <scratchDir>   (needs rust-analyzer; skips without it)
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES } from '../plugins/lsp-kit/languages.mjs';
import { alive, check, finish, killManager, log, privatePipe, processPath, startProxy, wait } from './client.mjs';

if (!LANGUAGES.rust.available()) {
	log('SKIP rust-analyzer is not installed');
	process.exit(0);
}
rmSync(process.argv[2], { recursive: true, force: true });
const repo = join(process.argv[2], 'crate');
mkdirSync(join(repo, 'src'), { recursive: true });
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
writeFileSync(join(repo, 'Cargo.toml'), '[package]\nname = "kit"\nversion = "0.1.0"\nedition = "2021"\n');
const text = 'fn helper(x: u32) -> u32 { x }\nfn main() { helper(1); }\nfn borrow() { let v = vec![1]; let r = &v; drop(v); println!("{:?}", r); }\nmod other;\n';
writeFileSync(join(repo, 'src', 'main.rs'), text);
writeFileSync(join(repo, 'src', 'other.rs'), 'pub fn other() -> u32 { 1 }\n');
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');
// The session reaches the crate through a junction (a symlink off Windows): a
// spelling that isn't the canonical path, like an 8.3 short name or a subst drive.
const root = join(process.argv[2], 'link');
symlinkSync(realpathSync.native(repo), root, 'junction');

const client = startProxy('rust', root);
await client.initialize(root);
const [pid] = client.pids();
const path = processPath(pid);
check(/^rust-analyzer(\.exe)?$/i.test(basename(path)), `the manager holds rust-analyzer itself (pid ${pid} is ${path})`);

// Go to definition of `helper` from its call in main, retried while rust-analyzer indexes.
const definitionIn = async (dir, c = client) => {
	const uri = pathToFileURL(join(dir, 'src', 'main.rs')).href;
	c.open(uri, 'rust', text);
	let r;
	for (let i = 0; i < 30; i++) {
		r = await c.req('textDocument/definition', { textDocument: { uri }, position: { line: 1, character: 12 } });
		if (r?.error || r?.length) break;
		await wait(1000);
	}
	return r;
};
const findsHelper = async (session, dir, c) => {
	const r = await definitionIn(dir, c);
	check(r?.some?.((d) => (d.range ?? d.targetRange)?.start.line === 0), `session at ${session}, goToDefinition via ${dir} finds helper: ${JSON.stringify(r)?.slice(0, 100)}`);
};
const real = realpathSync.native(repo);
await findsHelper(root, root);
await findsHelper(root, real);
const reverse = startProxy('rust', real);
await reverse.initialize(real);
await findsHelper(real, root, reverse);
reverse.proxy.stdin.end();
await reverse.exited;

// cargo check's borrow error (E0505) arrives pushed; an edit makes the manager
// pull rust-analyzer's own diagnostics, which must join it, not replace it.
const codes = new Map(); // file path -> the codes last published for it
client.onNotification = (m) => m.method === 'textDocument/publishDiagnostics' && codes.set(fileURLToPath(m.params.uri).toLowerCase(), m.params.diagnostics.map((d) => d.code?.value ?? d.code));
const mainCodes = () => codes.get(join(root, 'src', 'main.rs').toLowerCase()) ?? [];
const mainUri = pathToFileURL(join(root, 'src', 'main.rs')).href;
client.open(mainUri, 'rust', text);
for (let i = 0; i < 120 && !mainCodes().includes('E0505'); i++) await wait(1000);
check(mainCodes().includes('E0505'), `cargo check's borrow error arrives: ${JSON.stringify(mainCodes())}`);
client.notify('textDocument/didChange', { textDocument: { uri: mainUri, version: 2 }, contentChanges: [{ text: text + '// an edit\n' }] });
await wait(8000);
check(mainCodes().includes('E0505'), `it is still published after an edit and the pull it causes: ${JSON.stringify(mainCodes())}`);

// other.rs keeps changing on disk; rust-analyzer asks for a refresh after each
// change and the manager pulls main.rs again. That isn't use: the server still
// stops when idle.
const idleEnv = { LSP_KIT_PIPE: privatePipe(), LSP_KIT_IDLE_MS: '3000', CLAUDE_PLUGIN_DATA: join(process.argv[2], 'idle-data'), LSP_KIT_TRACE: '1' };
const idle = startProxy('rust', real, { ...idleEnv, name: 'idle' });
await idle.initialize(real);
idle.open(pathToFileURL(join(real, 'src', 'main.rs')).href, 'rust', text);
let churn = 0;
const stoppedIdle = () => idle.stderr.some((l) => / stopping Rust server #1 /.test(l));
for (const end = Date.now() + 30000; !stoppedIdle() && Date.now() < end; await wait(300)) writeFileSync(join(repo, 'src', 'other.rs'), `pub fn other() -> u32 { ${++churn} }\n`);
const idlePulls = readFileSync(join(idleEnv.CLAUDE_PLUGIN_DATA, `${idleEnv.LSP_KIT_PIPE}.log`), 'utf8').match(/ textDocument\/diagnostic /g)?.length ?? 0;
check(stoppedIdle() && idlePulls > 3, `the server stops when idle while files keep changing (${churn} writes of other.rs, ${idlePulls} pulls of main.rs)`);
await idle.close();
killManager(idle.manager);

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
killManager(client.manager);
for (let i = 0; i < 50 && pids.some(alive); i++) await wait(100);
check(pids.every((p) => !alive(p)), `every rust-analyzer (${pids.join(', ')}) exits with the manager (pid ${client.manager})`);
finish();
