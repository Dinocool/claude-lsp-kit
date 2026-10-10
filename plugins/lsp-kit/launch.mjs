// Starts the manager and exits at once, so the manager has no live parent.
// `taskkill /T` ends "the specified process and any child processes started by
// it" (Microsoft Learn, taskkill), found by parent process id (PROCESSENTRY32
// th32ParentProcessID); with this process gone, a tree kill of a session's
// proxy no longer reaches the manager every session shares. `detached` keeps
// the manager out of the job object libuv ends with this process (Node
// child_process docs, options.detached); windowsHide keeps it windowless.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

spawn(process.execPath, [fileURLToPath(new URL('./manager.mjs', import.meta.url))], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
