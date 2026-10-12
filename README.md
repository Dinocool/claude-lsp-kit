# claude-lsp-kit

A [Claude Code](https://claude.com/claude-code) plugin that gives the LSP tool
**Svelte**, **TypeScript and JavaScript**, **Rust** and **Lua** language servers. It keeps them responsive in
large repos, follows agents into the git worktrees they work in, and shares
each server among all sessions on the machine: one Rust, one TypeScript and
one Svelte server serve every checkout.

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
fixes six things.

**1. Whole-repo watcher fallbacks.** Claude Code's LSP client doesn't advertise
`workspace.didChangeWatchedFiles`. Without it, `svelte-language-server` starts
a chokidar watcher over the whole workspace, ignoring only `.git` and
`node_modules`. That includes agent worktrees under `.claude/worktrees`, which
are full copies of the repo. On Windows the crawl kept the server busy for
minutes, so every request timed out. lsp-kit tells each server the client
reports file changes. It then watches each of a server's workspace folders
itself with one native recursive `fs.watch`, skipping dot-directories,
`node_modules` and `target`. Changes reach the server in batches.

**2. Roots.** Claude Code roots its servers at the session's working
directory, which can be a subdirectory of the repo. Project config sits at the
repo root (`.luarc.json`, the Cargo workspace, `svelte.config.*`), and LuaLS
reads `.luarc.json` only from its workspace root, so a session started in a
subdirectory silently lost it. Every workspace folder is a git toplevel
instead: the session's is the toplevel of the session directory, and each
file's is the toplevel of the checkout that owns it.

**3. Worktrees.** Agents edit code in linked git worktrees, nested in the
session directory (`.claude/worktrees/<name>`) or beside it. A file in one goes
to that worktree's workspace folder, so an agent's hover, definitions and
references reflect its worktree's code, not main's. A path belongs to the most
specific folder holding it, so a worktree nested in main is its own folder.

Git submodules belong to their superproject's server; a nested clone is its
own checkout. Servers run in the home directory, so they never stop a
worktree from being removed on Windows.

**4. Shared servers for the whole machine.** Without them, every session ran
its own copy of the same index (rust-analyzer ~3.5 GB, LuaLS ~1.4 GB each),
and eight sessions on one repo exhausted a 32 GB machine. Every session shares
the servers, however each session spells a checkout's path (drive-letter case,
short names, junctions); each session only ever sees its own spelling.

- **Rust, TypeScript and Svelte: one server for every checkout,** each
  checkout a workspace folder of it. Measured on five checkouts of one repo:

  | Server | Five servers | One server, five folders |
  |---|---|---|
  | rust-analyzer | 18.8 GB | 6.7 GB |
  | TypeScript 7 | 1.7 GB | 1.1 GB |
  | svelte-language-server | 5.6 GB | 3.6 GB |

  Unsaved edits, references, definitions and workspace symbols stayed per
  folder in all three. A checkout that resolves another server binary gets a
  server of its own: one pinned to another toolchain by `rust-toolchain.toml`,
  or with another TypeScript or svelte-language-server version. Checkouts
  share by version, wherever each finds its copy.
- **Lua: one server per checkout,** its one folder.
- A checkout joins its server on its first request
  (`workspace/didChangeWorkspaceFolders`). rust-analyzer ignores folder
  changes while `linkedProjects` is set, so it also gets every folder's
  `Cargo.toml` files together (`workspace/didChangeConfiguration`, and the
  same answer to its `workspace/configuration` pull).
- svelte-language-server (0.18) reads its folders only at `initialize` and
  uses them only to accept the tsconfigs under them; a checkout outside them
  got wrong answers. So it is told its outermost checkouts (a worktree nested
  in main joins without a word), and a checkout outside all of them restarts
  it with that one added; requests in flight go to the new server. A
  `.svelte` file no tsconfig includes or imports, or a project without a
  tsconfig, makes it search the folder holding it for `svelte.config.*` files
  (`loadConfigs`): told a drive root, that search blocked it for minutes.
  It parses any document it gets as Svelte (a `.ts` one corrupts its
  references), so a request about a file of another language fails with the
  reason, for every language.
- Workspace symbols come back only from the folders the asking session
  uses: those it sent a request or opened a document in. Places outside
  every folder (a toolchain's sources) stay. Without the filter, a workspace
  symbol came back once per checkout. References and definitions keep every
  place: one in another checkout is real (a checkout importing another's
  files by path).

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
  the results, each filtered as above.

### Lifecycle

- The first session to need a language server starts the manager through a
  launcher that exits at once, so ending that session's process tree
  (`taskkill /T`) leaves the manager running for everyone. It listens on the named pipe `\\.\pipe\lsp-kit-<user>-p<version>` (a Unix
  socket in the plugin data directory elsewhere). Only one process can own
  it, so sessions starting together end up on one manager. `<version>` is a
  digest of the manager's code: after an update that changes it, new sessions
  start a new manager and the old one ends when its last session and server
  are gone.
- A server starts on the first request for a checkout it would serve. A
  checkout leaves its server after 5 minutes unused or when its directory is
  deleted; the last one leaving stops it.
- Servers free no memory when a folder leaves (rust-analyzer, TypeScript 7 and
  svelte-language-server, measured; TypeScript even keeps answering the removed folder's symbols). So
  a server not in use that has dropped folders restarts with its live ones
  when fewer than half its peak remain, or when it is over the memory limit.
  The new server reopens the open documents.
- No rule stops a server in use: one with a request in flight, or used
  within the last check (a minute, or a quarter of `LSP_KIT_IDLE_MS` if
  shorter). Otherwise a session's lookup could lose its server between two
  steps, and restart it (rust-analyzer re-indexing) for the next.
- At most 6 servers run on the machine (`LSP_KIT_MAX_SERVERS`). Starting
  one more stops the least recently used server not in use. If every one is
  in use, the cap is exceeded and logged.
- The servers may use a quarter of the machine's memory together
  (`LSP_KIT_MAX_MEMORY_MB`). Servers stop while the machine's free memory is
  under a floor (an eighth of its memory, `LSP_KIT_MIN_FREE_MB`). See
  [Memory](#memory).
- A crash hits every session a server serves. A server that exits unasked
  after answering a request restarts at once with its folders, and the log
  says so. One that stops, or dies before answering anything, starts again on
  the next request.
- When a session ends, its documents are released; its servers stay for
  the other sessions until they idle out. The manager exits once it has
  no connection (a session, or a proxy that hasn't said hello yet) and no
  server.
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

- On each check the manager measures each server. While the servers
  together use more than the limit, the least recently used one not in use
  stops, or a shared one restarts with its live folders; one whose folders
  are all live stays (stopping it frees nothing for long). If every server
  left is in use or serves only live folders, the limit is exceeded and
  logged.
- A server's memory is its own plus its child processes': rust-analyzer's
  proc-macro servers and cargo check use memory on its behalf, and end with
  it.
  - On Windows it is commit charge (Win32_Process `PageFileUsage`), what the
    machine ran out of.
  - Elsewhere it is resident memory (`ps` rss).
- A server that alone uses more than the limit follows the same rule. It
  stops whenever it is not in use, after any idle server used less
  recently. The log names it once per start, in capitals.
- While the machine's free memory is under the floor, the least recently
  used server not in use stops. It stops one per check, and none in a check
  that already stopped one (unused, or its directory gone): a stopped
  server's memory is freed as it exits, so the next reading is the first to
  show it. The servers' own limit can't see the rest of the machine; a dozen
  agent worktrees' servers once left so little free that Claude Code's
  low-memory handling killed background agents. The floor never refuses a
  start.
  - The floor is an eighth of the machine's memory (8 GB of 64, 2 GB of 16).
    `LSP_KIT_MIN_FREE_MB` sets it in MB, and `LSP_KIT_MIN_FREE_MB=0` turns
    it off.
  - Free memory is Node's `os.freemem()`. On Windows and Linux it counts
    memory the system can hand out at once (Linux `MemAvailable`, cache
    included). On macOS it counts only free pages, leaving out cached and
    inactive ones, so it reads lower and the floor triggers sooner.
- The memory limit, the floor and the server cap stop servers by this same
  rule.
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

- A manager is gone unless its pipe answers with the record's id. A manager
  restarted on the same pipe has a new id, so its predecessor's record is
  swept. That needs no clock, so a clock change can't make a live manager
  look gone. A pipe that doesn't answer within 5 s counts as alive.
- A process counts as lsp-kit's by its pid and start time together, so a
  later process that reuses the pid is never stopped.
- A server lsp-kit didn't start, such as an editor's own rust-analyzer, is
  never stopped. It isn't in any record.
- A record also lists its servers' own folders (LuaLS's `TMP`, see
  Per-language setup), written before each server starts. A server's folder
  goes when it stops; the sweep removes a gone manager's after stopping its
  processes. Only folders named `lsp-kit-tmp-…` in the data
  directory are removed, and one still in use keeps its record for the next
  sweep.
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
  `app/src-tauri` get analysis; a shared server gets every folder's. It also retries requests that get
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
  - The manager asks once at its start, without waiting, and logs the
    answer. The hooks reuse its last good answer from `lsp-kit-npm-root.json`
    in the plugin data directory. That file keeps one key: the node binary,
    the prefix setting and `~/.npmrc`.
- **TypeScript and JavaScript:** one TypeScript 7 server per version serves
  every `.ts`/`.js` flavour of every checkout. TypeScript 7 (July 2026) is the native port and
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
  is a node wrapper that runs it as a child. A running binary can't be
  deleted or replaced on Windows, so the shared server runs a copy of the
  platform package, made once per version in the plugin data directory
  (without blocking other sessions): from a checkout's `node_modules` it
  would lock that checkout, from npm's global folder `npm i -g`.
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
  functions named inside function bodies, with their ranges; the proxy's
  response shaping (6) then drops the fields deeper than file level.
  `workspaceSymbol` is not trimmed, so it still finds locals by name.
  - Each LuaLS server gets a `TMP` and `TEMP` folder of its own in the plugin
    data directory. On Windows, LuaLS's runtime
    ([bee.lua](https://github.com/actboy168/bee.lua/blob/master/bee/net/socket.cpp))
    makes every internal socket pair through one fixed file,
    `%TEMP%\bee1.tmp`. Two LuaLS processes doing so at once collide, and the
    loser hangs or exits with "Duplicate channel 'task:1'". In a trial, 17 of
    120 servers started together exited that way. With a folder each, none
    did. Two checkouts whose Lua servers start together are enough to hit it.
  - That file's path must fit in 107 bytes, the most a Windows socket path
    takes ([endpoint.cpp](https://github.com/actboy168/bee.lua/blob/master/bee/net/endpoint.cpp)).
    A longer one falls back to the shared `C:\Windows\Temp`, so a Lua server
    whose plugin data path is too long fails to start, naming the path.

If a server isn't installed, `initialize` and each later request fail with a
message that names it.

**6. Response shaping.** The proxy shapes each answer before the client renders
it, cutting what the rendering spends tokens on without losing anything a
ranged Read can't recover: `documentSymbol` outlines keep every symbol at file
level, navigational kinds (namespaces, modules, classes, methods,
constructors, enums, interfaces, functions, structs) at any depth, the members
of a type declaration (class, interface, struct, enum) whatever their kind,
and any symbol that still leads to a kept child (a table that holds functions
stays with them); other kinds below file level go (a plain field at depth 2 is
recoverable by a ranged Read). references, definition, implementation,
declaration and typeDefinition answers are deduped, keeping the server's
order, and never capped (the client prints its own count header); `hover`
passes through. `LSPKIT_RAW=1` turns shaping off for that session.

Diagnostics are gated the same way: a non-empty `publishDiagnostics` for a
file of a served language reaches the client only while the session has it
open (`didOpen` minus `didClose`, matched by file path however the uri is
spelled); a push for any other file — project config such as `tsconfig.json`
or `Cargo.toml`, whose errors say why answers come back empty — or an empty
push, a clear, always passes. The shared manager runs servers for every
session's worktree, and whole-project pushes for code files a session never
looked at are other sessions' churn rendering into its context — measured at
92% of one session's diagnostic bytes. The same `LSPKIT_RAW=1` switch
forwards every push.

## Settings

lsp-kit gives rust-analyzer one setting, `linkedProjects` (see Per-language
setup), and the other servers none: everything else is the server's own
default or the project's config. Settings that could cut memory were tried
with `tools/settings-trial.mjs` on a real repo: four Cargo workspaces, one of
them a Tauri app, and a WoW addon of about 180 Lua files with its own
`.luarc.json`. Each candidate ran the real server three times. Its
memory was read as the manager reads it, once indexing settled and again
after 53 fixed lookups (definitions, references, hover, document and
workspace symbols), and its answers and the diagnostics of three open files
were compared exactly with the defaults'. None cut memory with identical
answers, so none is a default.

| Server, setting | Memory after the lookups | Answers |
|---|---|---|
| rust-analyzer, defaults | 3.4 GB | |
| `cachePriming.enable: false` | 0.5 GB until the first workspace-wide lookup, then 3.6 GB | a macro-made symbol's location differed in one run |
| `lru.capacity: 32` (default 128) | 3.4 to 3.5 GB | same |
| `numThreads: 2` | 3.4 GB | same |
| `procMacro.enable: false` | 3.3 GB | macros unexpanded: "proc-macro expansion is disabled" errors |
| `cargo.targetDir: true` | 3.4 GB, plus 1.9 GB of disk | same |
| LuaLS, defaults | 1.0 to 1.3 GB | |
| `diagnostics.workspaceDelay: -1` | 0.5 GB until the lookups, then 0.9 to 1.1 GB | unopened files are no longer diagnosed, so an edit's errors in other files go unseen |
| `workspace.maxPreload: 100` | 0.6 to 0.8 GB | files past the limit lose definitions and references |
| `workspace.preloadFileSize: 100` | 0.8 to 0.9 GB | the same for files over 100 KB |
| the addon's `Libs` folder as `workspace.library` | 1.0 GB, within the defaults' spread | same: a folder inside the workspace stays a workspace folder |
| the addon's `Libs` folder in `workspace.ignoreDir` | 1.0 GB | its symbols are gone |

- Rust check-on-save stays on: cross-file errors after an edit come from it.
- `cargo.targetDir: true` doesn't save memory. It gives rust-analyzer's cargo
  check its own `target/rust-analyzer`, so it never waits on the lock of a
  build the user started, at the cost of a second build tree.
- Some answers vary between runs of the same settings: rust-analyzer's
  reference counts by one or two, LuaLS's type-mismatch diagnostics in a
  large file. The trial leaves out an answer that varies between the
  defaults' own runs.
- Sources: rust-analyzer's manual,
  [Configuration](https://rust-analyzer.github.io/book/configuration.html),
  and its `crates/rust-analyzer/src/config.rs` for which source wins; the
  LuaLS wiki's [Settings](https://luals.github.io/wiki/settings/) and
  [Configuration](https://luals.github.io/wiki/configuration/) pages.

A project tunes its servers in its own files:

- **Lua:** `.luarc.json` at the repo root. LuaLS reads `--configpath` first,
  then `.luarc.json`, then the client's settings, key by key; lsp-kit sends
  no client settings.
- **Rust:** a `rust-analyzer.toml` in the project root (the manual calls it
  work in progress) sets the per-workspace settings, such as `cargo.*` and
  `check.*`. The machine-wide ones, such as `cachePriming`, `lru`,
  `numThreads`, `procMacro` and `files.exclude`, come only from the client
  or the user's own `rust-analyzer.toml` in the user config folder
  (`%APPDATA%\rust-analyzer` on Windows, `~/.config/rust-analyzer` on
  Linux). lsp-kit sends only `linkedProjects`, so that file applies.

## Hooks: advertise the LSP and use it

The plugin's hooks only add context and never block a tool call:

- **SessionStart / SubagentStart:** says the LSP tool is deferred (load it
  with ToolSearch `select:LSP` first), lists the languages it serves in
  this project, then explains when to use `documentSymbol`, `goToDefinition`,
  `findReferences`, `hover`, call hierarchy and `workspaceSymbol` instead of
  Grep or whole-file Read, and for a large file to prefer `workspaceSymbol`
  with a query or `findReferences` from a known line, and that `Read` takes
  `offset`/`limit` for exact line ranges. A language is listed
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
  gone, the cap, the memory limit, the free memory floor).
- These variables in Claude Code's environment (for example `env` in
  `settings.json`) reach the manager when a session starts it:
  - `LSP_KIT_TRACE=1` adds every message to the log.
  - `LSP_KIT_MAX_SERVERS` sets the machine-wide cap (6).
  - `LSP_KIT_MAX_MEMORY_MB` sets the machine-wide memory limit in MB (a quarter
    of the machine's memory).
  - `LSP_KIT_MIN_FREE_MB` sets the machine's free memory floor in MB (an
    eighth of its memory; 0 turns it off).
  - `LSP_KIT_IDLE_MS` sets the idle stop (5 minutes; the tests shorten it).
  - `LSP_KIT_PIPE` names a private manager; the tests give each run its own.

  A running manager keeps the values it started with: end it (its pid is in
  the log) to apply new ones.
- `LSPKIT_RAW=1` turns response shaping off for that session; the proxy reads
  it, not the manager (see Response shaping).
- `node test/smoke.mjs <svelte|typescript|rust|lua> <root> <hover|references|documentSymbol|definition> <file:line:col>...`
  drives the proxy like Claude Code does, on a private manager.
- Each test below builds a throwaway project under `<scratchDir>`, runs its
  own private managers, and prints PASS/FAIL lines. On Windows the Lua tests
  need a `<scratchDir>` of at most 60 characters (see the Lua socket path):
- `node test/hooks.mjs <scratchDir>` checks what the hooks add, with a
  stub TypeScript 6 (not served) and then 7, and an empty npm global folder.
- `node test/shape.mjs <scratchDir>` checks response shaping: the
  documentSymbol outline rule and the location dedupe on synthetic
  payloads, then one real Lua answer raw beside shaped.
- `node test/diagnostics.mjs <scratchDir>` checks diagnostics gating against
  a fake manager: which pushes reach the session (open documents, clears,
  config files) and which are dropped.
- `node tools/measure-shaping.mjs <scratchDir>` is no test: it runs a fixed
  query set on generated Lua fixtures through the proxy, raw (LSPKIT_RAW=1)
  and shaped, and prints each answer's byte size before and after.
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
  two sessions (least recently used first, never one in use). The session's
  server stops when idle (one server per checkout however a request spells
  it), and a manager left alone exits, never before it has accepted the
  session that started it (its npm lookup made slower than the idle stop)
  and never while a connection that hasn't said hello is open. A server that can't start answers with the reason.
- `node test/memory.mjs <scratchDir>` sets a 1 MB limit. It checks that the
  least recently used idle Lua server stops first, then the next. A stub
  server with a request in flight never stops, and the limit is exceeded and
  logged; an idle stub Svelte server serving only live folders isn't stopped
  for it either, and when a checkout outside it restarts it, the new stub
  answers the request in flight while the old one's late error is ignored. A
  real server's measured memory is above zero and below the
  machine's. Under a free memory floor above the machine's memory, one idle
  server stops per check, least recently used first, never the stub nor a
  server used within the last check, and none in a check that stopped a
  server whose directory is gone. Above the floor, none stops. The tests'
  other managers run with the floor off, so the machine's own free memory
  never stops their servers: `LSP_KIT_MIN_FREE_MB=0` turns it off, and a
  value that isn't a number leaves the default. Then it kills the stub's
  manager: the stub's helper process (and the stub, off Windows) outlives
  it. The next manager's start stops them and logs it. A look-alike lsp-kit didn't start, the same program also
  without a live parent, keeps running, even with a gone manager's record
  naming its pid. So do a live manager's server and its record. A record
  naming the new manager's own pipe under another id is swept. With file
  creation denied in the data folder, the failed record write is logged and
  the manager goes on serving.
- `node test/typescript.mjs <scratchDir>` installs TypeScript 7 into its
  project (npm, so the first run needs the registry or npm's cache). It checks
  definitions and references across two `.ts` files and an `.mjs` file
  importing one, that two sessions share one server, and that the manager runs
  the native binary itself, copied to its data directory. It also checks that pulled diagnostics reach the
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
- `node test/folders.mjs <scratchDir>` puts three checkouts of one repo (main,
  a worktree nested in it, a sibling worktree beside it) on one rust-analyzer,
  one TypeScript 7 and one svelte-language-server; main has TypeScript 7 of
  its own, the worktrees the global one of the same version, and the server
  runs its copy in the plugin data directory. An unsaved edit in the nested worktree shows there
  and not in main, and the Svelte server's diagnostics for it reach its
  session. Workspace symbols come back only from the asker's folders, a
  `.svelte` definition into a `.ts` file stays in its worktree, a `.ts`
  request to the Svelte session fails, and references and definitions across
  checkouts keep both sides. The sibling joins the running servers and
  answers (rust-analyzer loads its `Cargo.toml`; the Svelte server restarts
  for it, resending a hover in flight in a `.svelte` file outside every
  tsconfig, answered within 20 s). Unused worktrees leave and each server
  restarts with main alone, which answers and stays watched; a TypeScript
  server killed after answering restarts without a request.
- `node test/svelte.mjs <scratchDir>` checks svelte-language-server, which
  advertises pull diagnostics but answers MethodNotFound, gets one pull and
  one log line however many changes follow.
- `node test/roots.mjs <scratchDir>` checks a session started in a
  subdirectory roots Lua at the git toplevel (`.luarc.json` applies), a
  sibling worktree gets its own server, and the Lua outline.
- `node test/start-race.mjs <scratchDir>` starts eight Lua servers at the
  same instant, ten rounds, each on a new manager. It checks every one
  answers, each live server has one folder of its own, and the next
  manager's sweep removes the folders of a killed one. A server that stops
  when idle removes its own. Its plugin data path is as long as Claude
  Code's, and a longer one makes the start fail with the reason.
- `node tools/settings-trial.mjs <rust|lua> <root> <scratchDir> <file>... [--runs n]`
  is no test: it runs each candidate setting on `<root>` and prints the
  table in [Settings](#settings). `<file>`s are the lookups' source and the
  diagnostics compared. Each run's results stay in `<scratchDir>`, so a rerun
  only runs what is missing. It writes into `<root>`: rust-analyzer's build
  trees, and for a `.luarc.json` candidate the file itself (restored after).
  Point it at a copy.

## License

MIT
