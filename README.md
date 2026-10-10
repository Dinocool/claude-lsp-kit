# claude-lsp-kit

A [Claude Code](https://claude.com/claude-code) plugin that gives the LSP tool
**Svelte**, **TypeScript and JavaScript**, **Rust** and **Lua** language servers. It keeps them responsive in
large repos, starts separate servers for the git worktrees agents work in, and
shares each server among all sessions on the machine.

| Language | Extensions | Server | Served when the repo root has |
|---|---|---|---|
| Svelte | `.svelte` | svelte-language-server | `svelte.config.*` |
| TypeScript and JavaScript | `.ts .mts .cts .tsx .js .mjs .cjs .jsx` | TypeScript 7 (`tsc --lsp`) | `tsconfig.json`, `jsconfig.json` or `package.json` |
| Rust | `.rs` | rust-analyzer | a `Cargo.toml` (any depth) |
| Lua | `.lua` | lua-language-server | `.luarc.json` |

## What it fixes

The language servers run in one manager process per machine
(`plugins/lsp-kit/manager.mjs`), which every Claude Code session reaches
through a small stdio proxy (`plugins/lsp-kit/proxy.mjs`); no dependencies. It
fixes five things.

**1. Whole-repo watcher fallbacks.** Claude Code's LSP client doesn't advertise
`workspace.didChangeWatchedFiles`. Without it, `svelte-language-server` starts
a chokidar watcher over the whole workspace, ignoring only `.git` and
`node_modules`. That includes agent worktrees under `.claude/worktrees`, which
are full copies of the repo. On Windows the crawl kept the server busy for
minutes, so every request timed out. lsp-kit tells each server the client
reports file changes. It then watches each server's root itself with one
native recursive `fs.watch`, skipping dot-directories, `node_modules` and
`target`. Changes reach the server in batches.

**2. Roots.** Claude Code roots its servers at the session's working
directory, which can be a subdirectory of the repo. Project config sits at the
repo root (`.luarc.json`, the Cargo workspace, `svelte.config.*`), and LuaLS
reads `.luarc.json` only from its workspace root, so a session started in a
subdirectory silently lost it. Every server is rooted at a git toplevel
instead: the session's server at the toplevel of the session directory, and
each file's server at the toplevel of the checkout that owns it.

**3. Worktrees.** Agents edit code in linked git worktrees, nested in the
session directory (`.claude/worktrees/<name>`) or beside it. A file in one goes
to a server rooted at that worktree, so an agent's hover, definitions and
references reflect its worktree's code, not main's.

Git submodules belong to their superproject's server; a nested clone is its
own checkout. Servers run in the home directory, so they never stop a
worktree from being removed on Windows.

**4. One server per checkout for the whole machine.** Without it, every
session ran its own copy of the same index (rust-analyzer ~3.5 GB, LuaLS
~1.4 GB each), and eight sessions on one repo exhausted a 32 GB machine.
Every session shares one server per language and checkout, however each
session spells the checkout's path (drive-letter case, short names,
junctions); each session only ever sees its own spelling.

- A document stays open on a shared server until the last session that
  opened it closes it or ends. When a second session opens or changes a
  document, the server reloads it from disk.
- Diagnostics go to every session with the document open. Claude Code's
  client only takes pushed diagnostics (`textDocument/publishDiagnostics`).
  So when a server advertises pull diagnostics (LSP 3.17
  `diagnosticProvider`), lsp-kit asks it for each open document with
  `textDocument/diagnostic`. It asks after every open or change and on the
  server's `workspace/diagnostic/refresh`, and passes each answer on as a
  push. TypeScript 7 serves only pulled diagnostics.
  - A document's pulled set joins its pushed set; it doesn't replace it. That
    matters for rust-analyzer, whose pushed cargo-check errors aren't in its
    pulled set.
  - One pull per document is in flight. A change cancels the older pull and
    ignores its late answer, so a slow answer for an old version never
    overwrites the current one.
  - A server that advertises pulls but answers MethodNotFound
    (svelte-language-server) is no longer asked; the log says so once.
  - Pulls don't count as use, so a server still stops when idle.
- `workspaceSymbol` asks the session checkout's server (starting it if it
  stopped) and every other running server the session has used, and merges
  the results.

### Lifecycle

- The first session to need a language server starts the manager through a
  launcher that exits at once, so ending that session's process tree
  (`taskkill /T`) leaves the manager running for everyone. It listens on the named pipe `\\.\pipe\lsp-kit-<user>-p<version>` (a Unix
  socket in the plugin data directory elsewhere). Only one process can own
  it, so sessions starting together end up on one manager. `<version>` is a
  digest of the manager's code: after an update that changes it, new sessions
  start a new manager and the old one ends when its last session and server
  are gone.
- A server starts on the first request for its checkout, and stops after
  10 minutes unused or when its directory is deleted.
- At most 10 servers run machine-wide (`LSP_KIT_MAX_SERVERS`). Starting one
  more stops the least recently used server without a request in flight. If
  every server has one, the cap is exceeded and logged.
- The servers may use 12 GB together (`LSP_KIT_MAX_MEMORY_MB`, in MB). See
  [Memory](#memory).
- A server that stops, crashes or is killed starts again on the next request
  for its checkout.
- When a session ends, its documents are released; its servers stay for
  the other sessions until they idle out. The manager exits once it has
  neither sessions nor servers.
- If the manager dies, its servers die with it, requests in flight fail with
  that reason, and each session's next request starts a new manager. If the
  manager can't be started or reached, every request fails with the reason.
  There is no per-session fallback.
- What a dead manager leaves behind is stopped when the next manager starts.
  See [Leftover servers](#leftover-servers).
- The manager runs with the environment of the session that started it.

### Memory

Memory per server grows with the checkout. Measured: rust-analyzer about
3.5 GB, LuaLS about 1.4 GB, TypeScript 7 about 0.4 GB on a mid-sized SvelteKit
repo with a few files open (more for each project it loads). Eight sessions'
own servers once took 24 GB and the machine ran out of commit.

- Once a minute (or every `LSP_KIT_IDLE_MS`, if shorter) the manager measures
  each server. While the servers together use more than the limit, the least
  recently used server without a request in flight stops. If every server
  left has one, the limit is exceeded and logged.
- A server's memory is its own plus its child processes': rust-analyzer's
  proc-macro servers and cargo check use memory on its behalf, and end with
  it.
  - On Windows it is commit charge (Win32_Process `PageFileUsage`), what the
    machine ran out of.
  - Elsewhere it is resident memory (`ps` rss).
- A server that alone uses more than the limit follows the same rule. It
  stops whenever it has no request in flight, after any idle server used less
  recently. The log names it once per start, in capitals.
- The memory limit and the server cap stop servers by this same rule.
- The log shows each server's memory when first measured, after each change
  of 10% or more, and at its stop, for example
  `Rust server #2 (pid 1234, 3 processes) uses 3.4 GB`.
- A failed measurement is logged, and the limit isn't applied until the next
  one succeeds.
- Measuring lists every process with one PowerShell `Get-CimInstance` (Windows)
  or one `ps`. No npm library fits:
  - [pidusage](https://www.npmjs.com/package/pidusage) reads working sets,
    which Windows trims under memory pressure, one process at a time.
  - [ps-list](https://www.npmjs.com/package/ps-list) has no memory on Windows.
  - [systeminformation](https://www.npmjs.com/package/systeminformation) runs
    the same query in a 1 MB package, and plugins have no install step.

### Leftover servers

A server's processes can outlive its manager.
- On Windows, Node puts a manager's servers in a job that ends them with the
  manager, but not the servers' own child processes.
- Elsewhere, a server that hangs past its manager's crash never notices it.

Each manager records the processes of its servers when each server starts
and on every measurement. The record is `lsp-kit-servers-<user>-<id>.json` in
the plugin data directory, with the manager's pipe. The next manager to start
stops every recorded process that's still running while the manager that
recorded it is gone, with its child processes. The log names the language,
checkout, pids and the gone manager.

- A manager is gone when its pipe no longer answers. That needs no clock, so
  a clock change can't make a live manager look gone.
- A process counts as lsp-kit's by its pid and start time together, so a
  later process that reuses the pid is never stopped.
- A server lsp-kit didn't start, such as an editor's own rust-analyzer, is
  never stopped. It isn't in any record.
- A record is removed only once its manager is gone. One that can't be read
  is logged and left in place.
- A record that can't be written is logged, and the next measurement tries
  again; the manager goes on serving.
- Helper processes a server starts after the last measurement aren't
  recorded yet.
- Processes left by lsp-kit before 3.2.0 have no record and aren't stopped.

### Limits

- Recursive `fs.watch` is native and cheap on Windows and macOS. On Linux,
  Node 20+ emulates it in JavaScript and watches every directory, which can
  hit inotify limits in very large trees.
- The memory measurement and leftover sweep are tested on Windows only.

**5. Per-language setup.**
- **Rust:** rust-analyzer only looks for `Cargo.toml` at the root and one
  level down. lsp-kit finds the top-level `Cargo.toml` in every subtree and
  passes them all as `linkedProjects`, so crates like `tools/foo` or
  `app/src-tauri` get analysis. It also retries requests that get
  `ContentModified` while rust-analyzer reloads, because Claude Code doesn't.
  Under rustup, lsp-kit starts the toolchain's rust-analyzer directly
  (`rustup which rust-analyzer`, run in the server's checkout so its
  `rust-toolchain.toml` applies): rustup's own `rust-analyzer` is a proxy
  that runs the real server as its child, which stopping it could orphan.
- **Svelte:** the server comes from the project's `node_modules` if it's
  there, otherwise from npm's global folder. That covers the Windows
  installer's `%AppData%\npm`, a custom prefix and version managers.
  - lsp-kit asks npm for the folder by running
    `npm exec --call "node -p process.env.npm_config_global_prefix"`
    ([npm exec](https://docs.npmjs.com/cli/commands/npm-exec) runs it in the
    environment npm gives package.json scripts). The folder under that
    prefix follows npm's
    [folders](https://docs.npmjs.com/cli/configuring-npm/folders) rule.
  - It doesn't use `npm root -g`: npm prints every UUID-like path segment as
    `***` (`@npmcli/redact`), so a prefix under Claude's temp folder would come
    back as a folder that doesn't exist.
  - An answer whose folder doesn't exist is a failed lookup, and a server
    that needed the folder names npm's answer in its start error.
  - The manager asks once at its start and logs the answer. The hooks reuse
    its last good answer from `lsp-kit-npm-root.json` in the plugin data
    directory. That file keeps one key: the node binary, the prefix setting
    and `~/.npmrc`.
- **TypeScript and JavaScript:** one TypeScript 7 server per checkout serves
  every `.ts`/`.js` flavour. TypeScript 7 (July 2026) is the native port and
  ships its own LSP server; Microsoft's
  [announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
  says it "should work great in any editor". It has no `tsserver`, so the
  tsserver wrappers can't serve a TypeScript 7 project. That includes
  [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server),
  whose README expects TypeScript 7 to supersede it, and
  [vtsls](https://github.com/yioneko/vtsls), last released December 2025 and
  self-described as best-effort. The server is the first TypeScript 7 or
  newer among the project's `typescript`, then its `@typescript/native` (the
  announcement's side-by-side alias of `typescript@7`), then npm's global
  `typescript`. lsp-kit starts the native binary from
  `@typescript/typescript-<platform>-<arch>` directly, because the `tsc` bin
  is a node wrapper that runs it as a child.
  - **TypeScript 6 projects** (Svelte's tooling still needs 6) are served by
    TypeScript 7, with TypeScript 7's semantics. A tsconfig option TypeScript
    7 removed (`baseUrl`, say, even with `ignoreDeprecations`) is a hard error
    there and does nothing, so definitions through it come back empty. The
    log names the project's version next to the server's, and TypeScript 7's
    tsconfig errors reach the session as diagnostics on `tsconfig.json`.
  - **Boundary with Svelte:** `.svelte` files stay with the Svelte server,
    and TypeScript 7 can't see inside them (that needs a tsserver plugin). So
    `findReferences` from a `.ts` symbol misses its uses in `.svelte` files,
    and `goToDefinition` on a component import in a `.ts` file lands on the
    ambient `*.svelte` module. Ask the Svelte server, from a `.svelte` file,
    for those. For the same reason the TypeScript server reports false errors
    about `*.svelte` modules in `.ts` files (TS2614 for a component's named
    export, say). lsp-kit passes them on unfiltered: they are its blind spot,
    and `svelte-check` is the authority.
  - **Files outside every tsconfig** (a `scripts/` folder the tsconfig doesn't
    include, say) each get an inferred project. References from a project
    file reach them only once they are open.
- **Lua:** scope and runtime come from the project's `.luarc.json`. Without one
  bounding the workspace, LuaLS scans every file under the root. LuaLS's
  `documentSymbol` lists every local, parameter and `if` block of every
  function (1,500 entries for a 1,900-line file); lsp-kit trims it to an
  outline: functions, methods, file-level variables and table fields, plus
  functions named inside function bodies, with their ranges.
  `workspaceSymbol` is not trimmed, so it still finds locals by name.

If a server isn't installed, `initialize` and each later request fail with a
message that names it.

## Hooks: advertise the LSP and use it

The plugin's hooks only add context and never block a tool call:

- **SessionStart / SubagentStart:** says the LSP tool is deferred (load it
  with ToolSearch `select:LSP` first), lists the languages it serves in
  this project, then explains when to use `documentSymbol`, `goToDefinition`,
  `findReferences`, `hover`, call hierarchy and `workspaceSymbol` instead of
  Grep or whole-file Read, and for a large file to prefer `workspaceSymbol`
  with a query or `findReferences` from a known line. A language is listed
  only if its project marker (in the table above) is present at the repo
  root and its server is installed.
- **Grep:** when the pattern is a bare identifier searched over a served
  language, a hint to use `workspaceSymbol` and `findReferences`. A glob or
  type names a language by its name or one of its extensions (`*.{ts,mjs}`,
  type `rust`). A Grep of one file gets the hint only when that file's
  language is served.
- **Read:** when Claude reads a file over 150 lines in a served language in
  full, a hint to get the outline with `documentSymbol` first.

Each Grep or Read adds about 0.1 s for the hook, mostly Node startup.

## Install

Install the language servers you need:

```sh
npm install -g svelte-language-server   # Svelte
npm install -g typescript@7             # TypeScript and JavaScript (unless the project has TypeScript 7 itself)
rustup component add rust-analyzer      # Rust
# Lua: lua-language-server on PATH (https://github.com/LuaLS/lua-language-server/releases)
```

Then install the plugin:

```sh
claude plugin marketplace add Dinocool/claude-lsp-kit
claude plugin install lsp-kit@claude-lsp-kit
```

Run `/reload-plugins` or restart Claude Code. Disable other LSP plugins for
the same file types, such as `rust-analyzer-lsp` or `typescript-lsp` from
the official marketplace.

To update, after a release bumped the version in `plugin.json` and
`.claude-plugin/marketplace.json`:

```sh
claude plugin marketplace update claude-lsp-kit
claude plugin update lsp-kit@claude-lsp-kit
```

Then restart each Claude Code session: a running session keeps the proxy it
started with, and with it its manager.

## Debugging

- The manager logs to `lsp-kit-<user>-p<version>.log` in the plugin data
  directory (`~/.claude/plugins/data/<plugin id>/`), and each session's proxy
  writes the same lines to its stderr (Claude Code's LSP log). Each server's
  own stderr (a rust-analyzer panic, say) goes to the log file only, as
  `<Lang> server #n stderr:` lines cut at 300 characters. The log of the
  manager before it is kept as `.previous.log`, a crash's stack included.
  Connections that don't open with a valid hello are turned away and see no
  log lines.
- Start and stop events are always logged, as `lsp-kit: <Lang> server #n for
  <root> (<n> live, pid <pid>)`, and each session's start as `session #n
  (<Lang>, pid <proxy pid>) joined manager pid <pid>`. Each stop names its
  pid, its last measured memory and why it stopped (unused, its directory is
  gone, the cap, the memory limit).
- These variables in Claude Code's environment (for example `env` in
  `settings.json`) reach the manager when a session starts it:
  - `LSP_KIT_TRACE=1` adds every message to the log.
  - `LSP_KIT_MAX_SERVERS` sets the machine-wide cap (10).
  - `LSP_KIT_MAX_MEMORY_MB` sets the machine-wide memory limit in MB (12288).
  - `LSP_KIT_IDLE_MS` sets the idle stop (10 minutes; the tests shorten it).
  - `LSP_KIT_PIPE` names a private manager; the tests give each run its own.

  A running manager keeps the values it started with: end it (its pid is in
  the log) to apply new ones.
- `node test/smoke.mjs <svelte|typescript|rust|lua> <root> <hover|references|documentSymbol|definition> <file:line:col>...`
  drives the proxy like Claude Code does, on a private manager.
- Each test below builds a throwaway project under `<scratchDir>`, runs its
  own private managers, and prints PASS/FAIL lines:
- `node test/hooks.mjs <scratchDir>` checks what the hooks add, with a
  stub TypeScript 6 (not served) and then 7, and an empty npm global folder.
- `node test/shared.mjs <scratchDir>` checks two sessions on one checkout
  share one server and each sees its own spelling of it. It checks documents
  stay open until the last session closes them or its proxy is killed, and
  diagnostics reach both sessions. Connections without a valid hello are
  turned away and hear nothing. A killed manager is replaced on the next
  request, proxies starting together end up on one manager, and on Windows
  the manager survives `taskkill /T` of the proxy that started it.
- `node test/lifecycle.mjs <scratchDir>` kills the session's and a
  worktree's server, and removes a worktree while its server runs. It checks
  no console window shows for the manager or its servers (Windows), that
  killing the manager stops every server, and the machine-wide cap across
  two sessions (least recently used first, never one with a request in
  flight). The session's server stops when idle (one server per checkout
  however a request spells it), and a manager left alone exits. A server
  that can't start answers with the reason.
- `node test/memory.mjs <scratchDir>` sets a 1 MB limit. It checks that the
  least recently used idle Lua server stops first, then the next. A stub
  server with a request in flight never stops, and the limit is exceeded and
  logged. A real server's measured memory is above zero and below the
  machine's. Then it kills the stub's manager: the stub's helper process
  (and the stub, off Windows) outlives it. The next manager's start stops
  them and logs it. A look-alike lsp-kit didn't start, the same program also
  without a live parent, keeps running, even with a gone manager's record
  naming its pid. So does a live manager's server whose record names a gone
  pid. With file creation denied in the data folder, the failed record write
  is logged and the manager goes on serving.
- `node test/typescript.mjs <scratchDir>` installs TypeScript 7 into its
  project (npm, so the first run needs the registry or npm's cache). It checks
  definitions and references across two `.ts` files and an `.mjs` file
  importing one, that two sessions share one server, and that the manager runs
  the native binary itself. It also checks that pulled diagnostics reach the
  session as pushes (after an open, and on refresh for other open files),
  that after two quick edits the last published set is always the last
  text's (20 runs), and that the TypeScript server counts toward the cap
  with a Lua server. A TypeScript 6 project with `@typescript/native` gets
  TypeScript 7, the log names both versions, and its removed `baseUrl`
  reaches the session as a tsconfig diagnostic. A TypeScript 7 without its
  platform package fails with that package's name. npm's global folder is
  an empty one of its own. A global TypeScript 7 under a UUID-named folder
  serves a project without one, and a global folder that doesn't exist is
  named in the start error.
- Every test keeps its plugin data (manager logs, the npm lookup cache) in
  its scratch folder.
- `node test/rust.mjs <scratchDir>` checks the manager holds rust-analyzer
  itself, a worktree pinned to another installed toolchain gets that
  toolchain's server, and every server exits with the manager. A borrow
  error only cargo check finds stays published after an edit (pushed and
  pulled sets are joined), and a server whose files keep changing on disk
  still stops when idle (refresh pulls aren't use).
- `node test/svelte.mjs <scratchDir>` checks svelte-language-server, which
  advertises pull diagnostics but answers MethodNotFound, gets one pull and
  one log line however many changes follow.
- `node test/roots.mjs <scratchDir>` checks a session started in a
  subdirectory roots Lua at the git toplevel (`.luarc.json` applies), a
  sibling worktree gets its own server, and the Lua outline.

## License

MIT
