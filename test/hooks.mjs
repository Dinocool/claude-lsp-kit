// Runs hooks/nudge.mjs against sample hook inputs in a throwaway Lua and
// TypeScript project under <dir>, prints what each adds and checks the notes
// and hints. Its TypeScript is a stub package (version and platform package
// only): first 6.x, which has no LSP server, then 7.x.
// Usage: node test/hooks.mjs <scratchDir>   (needs lua-language-server)
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish } from './client.mjs';

const root = join(process.argv[2], 'project');
rmSync(process.argv[2], { recursive: true, force: true });
mkdirSync(root, { recursive: true });
// An empty npm global folder (npm's prefix setting), so a global TypeScript 7 on
// this machine doesn't count.
const env = { ...process.env, npm_config_prefix: join(process.argv[2], 'empty-prefix') };
mkdirSync(env.npm_config_prefix);
writeFileSync(join(root, '.luarc.json'), '{}');
writeFileSync(join(root, 'big.lua'), 'local x = 1\n'.repeat(200));
writeFileSync(join(root, 'x.mjs'), 'export const helper = 1;\n');
writeFileSync(join(root, 'x.py'), 'helper = 1\n');
writeFileSync(join(root, 'big.ts'), 'export const x = 1;\n'.repeat(200));
writeFileSync(join(root, 'tsconfig.json'), '{}');
const typescript = (version) => {
	for (const name of ['typescript', `@typescript/typescript-${process.platform}-${process.arch}`]) {
		mkdirSync(join(root, 'node_modules', name), { recursive: true });
		writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
	}
};

const hook = fileURLToPath(new URL('../plugins/lsp-kit/hooks/nudge.mjs', import.meta.url));
const run = (event, extra) => {
	const out = execFileSync(process.execPath, [hook], { env, input: JSON.stringify({ hook_event_name: event, cwd: root, ...extra }) }).toString();
	const context = out ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
	console.log(`${event} ${JSON.stringify(extra.tool_input ?? extra)}\n   ${context ?? '-'}`);
	return context;
};
const grep = (input) => run('PreToolUse', { tool_name: 'Grep', tool_input: input });
const read = (input) => run('PreToolUse', { tool_name: 'Read', tool_input: input });
const DEFERRED = 'The LSP tool is deferred: load it once with ToolSearch query "select:LSP" before your first code lookup.';
const HINT = '"helper" is a symbol. For the next lookup use LSP (ToolSearch "select:LSP" if not loaded): workspaceSymbol query "helper" finds its definition; findReferences at that line lists every usage.';
const TS_NOTE = 'TypeScript and JavaScript (.ts, .mts, .cts, .tsx, .js, .mjs, .cjs, .jsx; TypeScript 7, also for a TypeScript 6 project (TypeScript 7 semantics: a tsconfig option it removed';

// TypeScript 6 has no LSP server: Lua alone is served.
typescript('6.0.3');
const note = run('SessionStart', {});
check(note?.startsWith(DEFERRED + " The LSP tool serves this project's Lua") && !note.includes('TypeScript'), 'SessionStart opens with how to load the deferred LSP tool; Lua only under TypeScript 6');
check(run('SubagentStart', { agent_type: 'general-purpose' })?.startsWith(DEFERRED), 'SubagentStart opens with it too');
check(grep({ pattern: 'helper' }) === HINT, 'Grep of an identifier over the project: hint');
check(grep({ pattern: '\\bhelper\\b', glob: '*.lua' }) === HINT, 'Grep of an identifier over *.lua: hint');
check(grep({ pattern: 'helper', path: join(root, 'big.lua') }) === HINT, 'Grep of an identifier in a .lua file: hint');
check(grep({ pattern: 'helper', path: join(root, 'x.mjs') }) === null, 'Grep of an identifier in a .mjs file under TypeScript 6: no hint');
check(grep({ pattern: 'helper', path: 'x.py' }) === null, 'Grep of an identifier in a .py file by relative path: no hint');
check(grep({ pattern: 'helper', type: 'rust' }) === null, 'Grep over a language this project lacks: no hint');
check(grep({ pattern: 'helper', glob: '*.json' }) === null, 'Grep over *.json: no hint');
check(grep({ pattern: 'help.*er' }) === null, 'Grep of a regex: no hint');
check(read({ file_path: join(root, 'big.lua') })?.startsWith('201-line file: LSP documentSymbol'), 'whole Read of a large .lua file: hint');
check(read({ file_path: join(root, 'big.lua'), offset: 10, limit: 20 }) === null, 'ranged Read: no hint');

// TypeScript 7: TypeScript and JavaScript are served too.
typescript('7.0.2');
check(run('SessionStart', {})?.includes(TS_NOTE), 'SessionStart lists TypeScript and JavaScript with every extension under TypeScript 7');
check(grep({ pattern: 'helper', path: join(root, 'x.mjs') }) === HINT, 'Grep of an identifier in a .mjs file: hint');
check(grep({ pattern: 'helper', path: 'x.mjs' }) === HINT, 'Grep of an identifier in a .mjs file by relative path: hint');
check(grep({ pattern: 'helper', glob: 'src/**/*.{ts,tsx}' }) === HINT, 'Grep of an identifier over *.{ts,tsx}: hint');
check(grep({ pattern: 'helper', type: 'js' }) === HINT, 'Grep of an identifier over type js: hint');
check(grep({ pattern: 'helper', glob: '*.json' }) === null, 'Grep over *.json: still no hint');
check(read({ file_path: join(root, 'big.ts') })?.startsWith('201-line file: LSP documentSymbol'), 'whole Read of a large .ts file: hint');
finish();
