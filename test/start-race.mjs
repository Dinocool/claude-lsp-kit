// LuaLS servers started at the same instant all answer: each runs with a TMP
// of its own (languages.mjs), since on Windows bee.lua's socket pairs share
// %TEMP%\bee1.tmp, and about one start in seven died with "Duplicate channel"
// or hung for good (a request to it never answered).
// Ten rounds, each on a manager of its own: a session on the repo, then one
// request to each of eight worktrees at once, so eight servers start together.
// Each round's manager is then killed, and the next manager's sweep removes
// the folders its servers left; a server that stops removes its own. The
// plugin data folder is as long as the one Claude Code gives lsp-kit, since a
// socket path past 107 bytes defeats the TMP of its own; past that, a server's
// start fails with the reason.
// Builds a throwaway repo under <dir>.
// Usage: node test/start-race.mjs <scratchDir>   (needs lua-language-server and git)
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGES } from '../plugins/lsp-kit/languages.mjs';
import { check, finish, killManager, log, scratch, startProxy, wait } from './client.mjs';

if (!LANGUAGES.lua.available()) {
	log('SKIP lua-language-server is not installed');
	process.exit(0);
}
const ROUNDS = 10;
const TOGETHER = 8;
scratch(process.argv[2]);
// CLAUDE_PLUGIN_DATA is ~/.claude/plugins/data/<plugin>-<marketplace> (Claude Code plugins reference).
const realData = join(homedir(), '.claude', 'plugins', 'data', 'lsp-kit-claude-lsp-kit');
const data = (process.env.CLAUDE_PLUGIN_DATA = join(process.argv[2], 'd'.repeat(Math.max(1, realData.length - process.argv[2].length - 1))));
mkdirSync(join(process.argv[2], 'repo'), { recursive: true });
const repo = realpathSync.native(join(process.argv[2], 'repo'));
const sh = (c) => execSync(c, { cwd: repo, stdio: 'pipe' }).toString().trim();
writeFileSync(join(repo, '.luarc.json'), '{"runtime.version":"Lua 5.1","workspace.ignoreDir":[".claude"]}');
writeFileSync(join(repo, 'a.lua'), 'local function helper(x) return x end\nhelper(1)\nhelper(2)\n');
sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init');
const worktrees = [...Array(TOGETHER)].map((_, i) => (sh(`git worktree add -q .claude/worktrees/w${i}`), join(repo, '.claude', 'worktrees', `w${i}`)));

const SERVER_DIRS = 'lsp-kit-tmp-'; // manager.mjs's server folders
const serverDirs = () => readdirSync(data).filter((f) => f.startsWith(SERVER_DIRS));
const until = async (cond, ms) => {
	for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await wait(200);
	return cond();
};
// helper's references, asked until the index has all three; an error (the
// server died, or hung past NO_ANSWER_MS) ends the asking, as a restart would hide it.
const NO_ANSWER_MS = 30 * 1000;
const refs = async (client, dir) => {
	const params = { textDocument: { uri: pathToFileURL(join(dir, 'a.lua')).href }, position: { line: 0, character: 16 }, context: { includeDeclaration: true } };
	let r;
	for (let i = 0; i < 40; i++) {
		r = await Promise.race([client.req('textDocument/references', params), wait(NO_ANSWER_MS).then(() => ({ error: `no answer in ${NO_ANSWER_MS / 1000} s` }))]);
		if (r?.error || r?.length === 3) break;
		await wait(500);
	}
	return r?.error ? `ERROR ${r.error}` : `${r?.length ?? 0} refs`;
};

for (let round = 1; round <= ROUNDS; round++) {
	const client = startProxy('lua', repo, { name: `round ${round}`, LSP_KIT_MAX_SERVERS: String(TOGETHER + 1) });
	await client.initialize(repo);
	const answers = await Promise.all(worktrees.map((dir) => refs(client, dir)));
	const failed = answers.filter((a) => a !== '3 refs');
	check(!failed.length, `round ${round}: ${TOGETHER} servers started together all answer${failed.length ? ` (${failed.join('; ')})` : ''}`);
	// The previous round's folders were swept at this manager's start; this one's servers have one each.
	check(await until(() => serverDirs().length === TOGETHER + 1, 10000), `round ${round}: one folder per live server, none left from the killed manager (${serverDirs().length})`);
	killManager(client.manager);
	client.proxy.kill();
}

// A manager whose servers stop on their own leaves no folder.
const last = startProxy('lua', repo, { name: 'last', LSP_KIT_IDLE_MS: '2000' });
await last.initialize(repo);
check((await refs(last, repo)) === '3 refs', 'a last manager serves the repo');
check(await until(() => serverDirs().length === 1, 10000), `its sweep removed the killed manager's folders (${serverDirs().length} left)`);
await last.close();
check(await until(() => serverDirs().length === 0, 15000), `its server stopped when idle and removed its folder (${serverDirs().join(', ') || 'none left'})`);

if (process.platform === 'win32') {
	const long = startProxy('lua', repo, { name: 'long', CLAUDE_PLUGIN_DATA: join(process.argv[2], 'l'.repeat(100)) });
	const init = await long.initialize(repo);
	check(/socket file .* past the 107 a Windows socket path takes/.test(init?.error), `with a plugin data folder too long, the start fails with the reason (${init?.error})`);
	await long.close();
}
finish();
