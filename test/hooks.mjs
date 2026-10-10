// Runs hooks/nudge.mjs against sample hook inputs for a project root and prints
// which ones add context. Usage: node test/hooks.mjs <projectRoot> [aLargeFile]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [root, largeFile] = process.argv.slice(2);
const hook = fileURLToPath(new URL('../plugins/lsp-kit/hooks/nudge.mjs', import.meta.url));
const cases = [
	['SessionStart', {}],
	['SubagentStart', { agent_type: 'general-purpose' }],
	['PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'sectionColor' } }],
	['PreToolUse', { tool_name: 'Grep', tool_input: { pattern: '\\bfoo\\b', glob: '*.{ts,svelte}' } }],
	['PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'PlanGraph', glob: '*.lua' } }],
	['PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'reseed', type: 'rust' } }],
	['PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'foo', glob: '*.json' } }],
	['PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'foo.*bar' } }],
	...(largeFile ? [['PreToolUse', { tool_name: 'Read', tool_input: { file_path: largeFile } }]] : []),
	...(largeFile ? [['PreToolUse', { tool_name: 'Read', tool_input: { file_path: largeFile, offset: 10, limit: 20 } }]] : [])
];
for (const [event, extra] of cases) {
	const out = execFileSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: event, cwd: root, ...extra }) }).toString();
	const context = out ? JSON.parse(out).hookSpecificOutput.additionalContext : '-';
	console.log(`${event} ${JSON.stringify(extra.tool_input ?? extra)}\n   ${context}`);
}
