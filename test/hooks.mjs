// Runs hooks/nudge.mjs against sample hook inputs in a throwaway Lua project
// under <dir>, prints what each adds and checks the notes and hints.
// Usage: node test/hooks.mjs <scratchDir>   (needs lua-language-server)
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish } from './client.mjs';

const root = join(process.argv[2], 'project');
rmSync(process.argv[2], { recursive: true, force: true });
mkdirSync(root, { recursive: true });
writeFileSync(join(root, '.luarc.json'), '{}');
writeFileSync(join(root, 'big.lua'), 'local x = 1\n'.repeat(200));
writeFileSync(join(root, 'x.mjs'), 'export const helper = 1;\n');

const hook = fileURLToPath(new URL('../plugins/lsp-kit/hooks/nudge.mjs', import.meta.url));
const run = (event, extra) => {
	const out = execFileSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: event, cwd: root, ...extra }) }).toString();
	const context = out ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
	console.log(`${event} ${JSON.stringify(extra.tool_input ?? extra)}\n   ${context ?? '-'}`);
	return context;
};
const grep = (input) => run('PreToolUse', { tool_name: 'Grep', tool_input: input });
const read = (input) => run('PreToolUse', { tool_name: 'Read', tool_input: input });
const DEFERRED = 'The LSP tool is deferred: load it once with ToolSearch query "select:LSP" before your first code lookup.';
const HINT = '"helper" is a symbol. For the next lookup use LSP (ToolSearch "select:LSP" if not loaded): workspaceSymbol query "helper" finds its definition; findReferences at that line lists every usage.';

check(run('SessionStart', {})?.startsWith(DEFERRED + ' The LSP tool serves this project\'s Lua'), 'SessionStart opens with how to load the deferred LSP tool');
check(run('SubagentStart', { agent_type: 'general-purpose' })?.startsWith(DEFERRED), 'SubagentStart opens with it too');
check(grep({ pattern: 'helper' }) === HINT, 'Grep of an identifier over the project: hint');
check(grep({ pattern: '\\bhelper\\b', glob: '*.lua' }) === HINT, 'Grep of an identifier over *.lua: hint');
check(grep({ pattern: 'helper', path: join(root, 'big.lua') }) === HINT, 'Grep of an identifier in a .lua file: hint');
check(grep({ pattern: 'helper', path: join(root, 'x.mjs') }) === null, 'Grep of an identifier in a .mjs file: no hint');
check(grep({ pattern: 'helper', path: 'x.mjs' }) === null, 'Grep of an identifier in a .mjs file by relative path: no hint');
check(grep({ pattern: 'helper', type: 'rust' }) === null, 'Grep over a language this project lacks: no hint');
check(grep({ pattern: 'helper', glob: '*.json' }) === null, 'Grep over *.json: no hint');
check(grep({ pattern: 'help.*er' }) === null, 'Grep of a regex: no hint');
check(read({ file_path: join(root, 'big.lua') })?.startsWith('201-line file: LSP documentSymbol'), 'whole Read of a large .lua file: hint');
check(read({ file_path: join(root, 'big.lua'), offset: 10, limit: 20 }) === null, 'ranged Read: no hint');
finish();
