// The machine's processes as the OS reports them: the manager's memory limit
// and its sweep of leftover servers read them. Node has no API for another
// process's memory or start time, and the npm options don't fit:
// - pidusage (4.0.1) reads a working set through wmic or PowerShell's gwmi,
//   one process at a time; Windows trims working sets under memory pressure,
//   exactly when the limit matters, and a server's helpers need the tree.
// - ps-list (9.0.0) gives no memory on Windows; systeminformation (5.33.15)
//   runs this same Win32_Process query inside a 1 MB package, and the plugin
//   has no install step (Claude Code's plugins reference: dependencies are
//   installed into CLAUDE_PLUGIN_DATA by the plugin itself).
// So the manager asks the OS's own documented interfaces:
// - Windows: the Win32_Process WMI class (Microsoft Learn, "Win32_Process
//   class"). PageFileUsage (KB) is SYSTEM_PROCESS_INFORMATION's PagefileUsage,
//   "the Commit Charge value ... for this process" (PROCESS_MEMORY_COUNTERS):
//   the commit limit is what the machine ran out of. Its docs: a pid is reused,
//   so ParentProcessId can name a later process; CreationDate tells them apart.
// - Elsewhere: `ps -A -o pid=,ppid=,rss=,lstart=` (rss and lstart are in procps
//   and BSD ps): resident KiB, since with overcommit resident memory is what
//   runs out. A process whose parent exits is reparented, so its ppid is live.
// A failed listing rejects with the reason; nothing is estimated.
import { execFile } from 'node:child_process';

const WINDOWS = [
	'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,PageFileUsage,CreationDate | ForEach-Object {',
	"if ($_.CreationDate) { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.PageFileUsage, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }"
].join(' ');
const LIST_MS = 30 * 1000;

// pid -> { pid, ppid, bytes, created (ms) }; `created` with `pid` names one process.
export function processes() {
	const [command, args] =
		process.platform === 'win32' ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS]] : ['ps', ['-A', '-o', 'pid=,ppid=,rss=,lstart=']];
	return new Promise((resolve, reject) =>
		execFile(command, args, { encoding: 'utf8', timeout: LIST_MS, windowsHide: true, maxBuffer: 16 << 20, env: { ...process.env, LC_ALL: 'C' } }, (e, stdout) => {
			if (e) return reject(new Error(`listing processes failed: ${e.message.split('\n')[0]}`));
			const list = new Map();
			for (const line of stdout.split('\n')) {
				const [pid, ppid, kb, ...start] = line.trim().split(/\s+/);
				const created = start.length === 1 ? Number(start[0]) : Date.parse(start.join(' '));
				if (pid && !Number.isNaN(created)) list.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), bytes: Number(kb) * 1024, created });
			}
			resolve(list);
		})
	);
}

// The process `pid` and every live descendant: a child counts only if created
// no earlier than its parent (a parent's pid reused later isn't its parent).
export function tree(list, pid) {
	const children = new Map();
	for (const p of list.values()) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
	const found = new Map();
	const walk = (p) => {
		if (found.has(p.pid)) return;
		found.set(p.pid, p);
		for (const c of children.get(p.pid) ?? []) if (c.created >= p.created) walk(c);
	};
	if (list.has(pid)) walk(list.get(pid));
	return [...found.values()];
}

export const sameProcess = (list, { pid, created }) => list.get(pid)?.created === created;
