// Hook: steer Claude to the LSP tool for code navigation in Svelte projects.
// It never blocks; it only adds context:
//   SessionStart          - one short note on what the LSP answers better than text search
//   PreToolUse Grep       - the pattern is a bare identifier over JS/TS/Svelte files
//   PreToolUse Read       - a whole read of a large .svelte file
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const LARGE_COMPONENT_LINES = 150;
const SVELTE_CONFIGS = ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.cjs', 'svelte.config.ts'];
const JS_FAMILY = /svelte|\b[cm]?[jt]sx?\b|\{[^}]*\b[jt]s\b/;
const IDENTIFIER = /^(\\b)?[A-Za-z_$][\w$]*(\\b)?$/;

const SESSION_NOTE =
	'This is a Svelte project with the LSP tool on .svelte files (TypeScript-aware, sees every .ts/.js the project imports). ' +
	'Navigate code with it instead of Grep/whole-file Read: documentSymbol for a component outline with line numbers, ' +
	'goToDefinition / findReferences / hover from any .svelte position (results include .ts files), ' +
	'workspaceSymbol (with a query) to locate a function or type by name. Use Grep for text, not symbols.';

const input = JSON.parse(readFileSync(0, 'utf8'));
const event = input.hook_event_name;
const cwd = input.cwd ?? process.cwd();
const context = SVELTE_CONFIGS.some((f) => existsSync(join(cwd, f)))
	? event === 'SessionStart'
		? SESSION_NOTE
		: toolHint(input.tool_name, input.tool_input ?? {})
	: null;
if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));

function toolHint(tool, args) {
	if (tool === 'Grep' && IDENTIFIER.test(args.pattern ?? '') && JS_FAMILY.test(`${args.glob ?? ''} ${args.type ?? ''}`.trim() || 'js')) {
		const name = args.pattern.replace(/\\b/g, '');
		return `For the symbol "${name}", LSP is exact where Grep is textual: workspaceSymbol (query "${name}") finds its definition, then findReferences / goToDefinition from a .svelte file that uses it lists every usage across .svelte and .ts files.`;
	}
	if (tool === 'Read' && extname(args.file_path ?? '') === '.svelte' && args.offset == null && args.limit == null) {
		const lines = existsSync(args.file_path) ? readFileSync(args.file_path, 'utf8').split('\n').length : 0;
		if (lines > LARGE_COMPONENT_LINES)
			return `${lines}-line component: LSP documentSymbol gives its outline (script symbols, markup, styles) with line numbers; read only the ranges you need with offset/limit.`;
	}
	return null;
}
