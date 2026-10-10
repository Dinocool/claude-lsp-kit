// Hook: advertise the LSP tool for every lsp-kit language present in the
// project (marker found AND server installed), and steer symbol work to it.
// It never blocks; it only adds context:
//   SessionStart, SubagentStart - which languages the LSP tool serves, what to use it for
//   PreToolUse Grep             - the pattern is a bare identifier over a served language
//                                 (a Grep of one file only when its language is served)
//   PreToolUse Read             - a whole read of a large file in a served language
// Tool hooks run on every Grep/Read, so they filter on the cheap input first and
// probe only the languages that could match.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { LANGUAGES, gitRoot } from '../languages.mjs';

const LARGE_FILE_LINES = 150;
const LARGE_FILE_TIP = 'for a large file, workspaceSymbol with a query, or findReferences from a known line, is more direct than its whole outline';
const IDENTIFIER = /^(\\b)?[A-Za-z_$][\w$]*(\\b)?$/;
// A Grep glob or type names a language by its key or one of its extensions
// (`*.{ts,mjs}`, type `rust`); an unscoped Grep matches every language.
const SCOPE = Object.fromEntries(
	Object.entries(LANGUAGES).map(([k, l]) => [k, new RegExp(`\\b(${[k, ...Object.keys(l.extensionToLanguage).map((e) => e.slice(1))].join('|')})\\b`)])
);

let input, root;
const served = (keys) => keys.map((k) => LANGUAGES[k]).filter((l) => l.present(root) && l.available(root));
// The languages serving a file, by its extension (none for a file lsp-kit doesn't serve).
const languagesOf = (file) => Object.keys(LANGUAGES).filter((k) => Object.hasOwn(LANGUAGES[k].extensionToLanguage, extname(file)));

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
	const list = langs.map((l) => `${l.name} (${Object.keys(l.extensionToLanguage).join(', ')}; ${l.note})`).join('; ');
	return (
		'The LSP tool is deferred: load it once with ToolSearch query "select:LSP" before your first code lookup. ' +
		`The LSP tool serves this project's ${list}. Use it for code navigation instead of Grep or whole-file Read: ` +
		`documentSymbol = a file outline with line numbers (then Read only the ranges you need; ${LARGE_FILE_TIP}); ` +
		'goToDefinition / findReferences / hover / incomingCalls / outgoingCalls at a symbol position; ' +
		'workspaceSymbol with a query = find a function, type or table by name. ' +
		'LSP calls on files inside a git worktree are answered by a server for that worktree. Grep is for text, not symbols.'
	);
}

function toolHint(tool, args) {
	if (tool === 'Grep' && IDENTIFIER.test(args.pattern ?? '')) {
		const file = args.path && statSync(resolve(input.cwd ?? '', args.path), { throwIfNoEntry: false })?.isFile();
		const scope = `${args.glob ?? ''} ${args.type ?? ''}`.trim();
		const keys = file ? languagesOf(args.path) : Object.keys(SCOPE).filter((k) => !scope || SCOPE[k].test(scope));
		if (!served(keys).length) return null;
		const name = args.pattern.replace(/\\b/g, '');
		return `"${name}" is a symbol. For the next lookup use LSP (ToolSearch "select:LSP" if not loaded): workspaceSymbol query "${name}" finds its definition; findReferences at that line lists every usage.`;
	}
	if (tool === 'Read' && args.offset == null && args.limit == null && existsSync(args.file_path ?? '')) {
		const keys = languagesOf(args.file_path);
		if (!keys.length) return null;
		const lines = readFileSync(args.file_path, 'utf8').split('\n').length;
		if (lines > LARGE_FILE_LINES && served(keys).length)
			return `${lines}-line file: LSP documentSymbol gives its outline with line numbers (${LARGE_FILE_TIP}); read only the ranges you need with offset/limit.`;
	}
	return null;
}
