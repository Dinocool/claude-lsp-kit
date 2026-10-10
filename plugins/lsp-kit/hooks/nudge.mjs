// Hook: advertise the LSP tool for every lsp-kit language present in the
// project (marker found AND server installed), and steer symbol work to it.
// It never blocks; it only adds context:
//   SessionStart, SubagentStart - which languages the LSP tool serves, what to use it for
//   PreToolUse Grep             - the pattern is a bare identifier over a served language
//   PreToolUse Read             - a whole read of a large file in a served language
// Tool hooks run on every Grep/Read, so they filter on the cheap input first and
// probe only the languages that could match.
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { LANGUAGES, gitRoot } from '../languages.mjs';

const LARGE_FILE_LINES = 150;
const LARGE_FILE_TIP = 'for a large file, workspaceSymbol with a query, or findReferences from a known line, is more direct than its whole outline';
const IDENTIFIER = /^(\\b)?[A-Za-z_$][\w$]*(\\b)?$/;
// Grep glob/type words per language; an unscoped Grep matches every language.
const SCOPE = { svelte: /svelte|\b[cm]?[jt]sx?\b|\{[^}]*\b[jt]s\b/, rust: /\brs\b|rust/, lua: /\blua\b/ };

let input, root;
const served = (keys) => keys.map((k) => LANGUAGES[k]).filter((l) => l.present(root) && l.available(root));

// A hint is optional: any failure (odd input, unreadable file) means no hint, never an error.
try {
	input = JSON.parse(readFileSync(0, 'utf8'));
	const cwd = input.cwd ?? process.cwd();
	root = gitRoot(cwd) ?? cwd; // project markers sit at the repo root, whatever the cwd
	const event = input.hook_event_name;
	const context = event === 'SessionStart' || event === 'SubagentStart' ? sessionNote() : toolHint(input.tool_name, input.tool_input ?? {});
	if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
} catch {}

function sessionNote() {
	const langs = served(Object.keys(LANGUAGES));
	if (!langs.length) return null;
	const list = langs.map((l) => `${l.name} (${l.extensions.join(', ')}; ${l.note})`).join('; ');
	return (
		`The LSP tool serves this project's ${list}. Use it for code navigation instead of Grep or whole-file Read: ` +
		`documentSymbol = a file outline with line numbers (then Read only the ranges you need; ${LARGE_FILE_TIP}); ` +
		'goToDefinition / findReferences / hover / incomingCalls / outgoingCalls at a symbol position; ' +
		'workspaceSymbol with a query = find a function, type or table by name. ' +
		'LSP calls on files inside a git worktree are answered by a server for that worktree. Grep is for text, not symbols.'
	);
}

function toolHint(tool, args) {
	if (tool === 'Grep' && IDENTIFIER.test(args.pattern ?? '')) {
		const scope = `${args.glob ?? ''} ${args.type ?? ''}`.trim();
		const langs = served(Object.keys(SCOPE).filter((k) => !scope || SCOPE[k].test(scope)));
		if (!langs.length) return null;
		const name = args.pattern.replace(/\\b/g, '');
		const exts = langs.flatMap((l) => l.extensions).join('/');
		return `"${name}" is a symbol: the LSP tool is exact where Grep is textual. workspaceSymbol (query "${name}") finds its definition; findReferences / goToDefinition from a ${exts} file that uses it lists every usage.`;
	}
	if (tool === 'Read' && args.offset == null && args.limit == null && existsSync(args.file_path ?? '')) {
		const key = Object.keys(LANGUAGES).find((k) => LANGUAGES[k].extensions.includes(extname(args.file_path)));
		if (!key) return null;
		const lines = readFileSync(args.file_path, 'utf8').split('\n').length;
		if (lines > LARGE_FILE_LINES && served([key]).length)
			return `${lines}-line file: LSP documentSymbol gives its outline with line numbers (${LARGE_FILE_TIP}); read only the ranges you need with offset/limit.`;
	}
	return null;
}
