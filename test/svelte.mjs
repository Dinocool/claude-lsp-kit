// Svelte, in a throwaway project under <dir>: svelte-language-server advertises
// pull diagnostics but answers them with MethodNotFound, so the manager stops
// pulling after the first answer and says so once in the log, however many
// changes follow.
// Usage: node test/svelte.mjs <scratchDir>   (needs svelte-language-server and git)
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGES } from '../plugins/lsp-kit/languages.mjs';
import { check, finish, log, privatePipe, startProxy, wait } from './client.mjs';

rmSync(process.argv[2], { recursive: true, force: true });
mkdirSync(join(process.argv[2], 'app'), { recursive: true });
const app = join(realpathSync.native(process.argv[2]), 'app');
if (!LANGUAGES.svelte.available(app)) {
	log('SKIP svelte-language-server is not installed');
	process.exit(0);
}
const text = '<script lang="ts">\n\tlet n: number = 1;\n</script>\n\n<p>{n}</p>\n';
writeFileSync(join(app, 'package.json'), '{ "name": "app", "private": true, "type": "module" }\n');
writeFileSync(join(app, 'svelte.config.js'), 'export default {};\n');
writeFileSync(join(app, 'A.svelte'), text);
execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: app, stdio: 'pipe' });

const env = { LSP_KIT_PIPE: privatePipe(), CLAUDE_PLUGIN_DATA: join(process.argv[2], 'data'), LSP_KIT_TRACE: '1' };
const client = startProxy('svelte', app, { ...env, name: 'svelte' });
await client.initialize(app);
const uri = pathToFileURL(join(app, 'A.svelte')).href;
client.open(uri, 'svelte', text);
const notes = () => client.stderr.filter((l) => l.includes("advertises pull diagnostics but doesn't answer them"));
for (let i = 0; i < 100 && !notes().length; i++) await wait(100);
for (let v = 2; v <= 6; v++, await wait(300)) client.notify('textDocument/didChange', { textDocument: { uri, version: v }, contentChanges: [{ text: text + `<!-- ${v} -->\n` }] });
await wait(2000);
const pulls = readFileSync(join(env.CLAUDE_PLUGIN_DATA, `${env.LSP_KIT_PIPE}.log`), 'utf8').match(/ textDocument\/diagnostic /g)?.length ?? 0;
check(notes().length === 1, `the first pull's MethodNotFound is logged once: ${JSON.stringify(notes())}`);
check(pulls === 1, `no pull for the five changes after it: ${pulls} in all`);
await client.close();
finish();
