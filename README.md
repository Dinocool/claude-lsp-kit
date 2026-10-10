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
  A server that advertises pull diagnostics (LSP 3.17 `diagnosticProvider`;
  TypeScript 7 serves no others) is asked with `textDocument/diagnostic`
  after every open or change and on its `workspace/diagnostic/refresh`. Its
  report reaches the sessions as a push.
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
- A server that stops, crashes or is killed starts again on the next request
  for its checkout.
- When a session ends, its documents are released; its servers stay for
  the other sessions until they idle out. The manager exits once it has
  neither sessions nor servers.
- If the manager dies, its servers die with it, requests in flight fail with
  that reason, and each session's next request starts a new manager. If the
  manager can't be started or reached, every request fails with the reason.
  There is no per-session fallback.
- The manager runs with the environment of the session that started it.

### Limits

- Recursive `fs.watch` is native and cheap on Windows and macOS. On Linux,
  Node 20+ emulates it in JavaScript and watches every directory, which can
  hit inotify limits in very large trees.
- Memory per server grows with the checkout. Measured: rust-analyzer about
  3.5 GB, LuaLS about 1.4 GB, TypeScript 7 about 0.4 GB on a mid-sized
  SvelteKit repo with a few files open (more for each project it loads). The
  cap counts servers, not memory.

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
  there, otherwise from the global install next to `node`.
- **TypeScript and JavaScript:** one TypeScript 7 server per checkout serves
  every `.ts`/`.js` flavour. TypeScript 7 (July 2026) is the native port and
  ships its own LSP server; Microsoft's
  [announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
  says it "should work great in any editor". It has no `tsserver`, so the
  tsserver wrappers can't serve a TypeScript 7 project. That includes
  [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server),
  whose README expects TypeScript 7 to supersede it, and
  [vtsls](https://github.com/yioneko/vtsls), last released December 2025 and
  self-described as best-effort. The server is the first TypeScript 7 or newer
  found in the project's `node_modules`, then in the global install next to
  `node`. A project still on TypeScript 6 (Svelte's tooling needs it) is
  served by the global one. lsp-kit starts the native binary from
  `@typescript/typescript-<platform>-<arch>` directly, because the `tsc` bin
  is a node wrapper that runs it as a child.
  - **Boundary with Svelte:** `.svelte` files stay with the Svelte server,
    and TypeScript 7 can't see inside them (that needs a tsserver plugin). So
    `findReferences` from a `.ts` symbol misses its uses in `.svelte` files,
    and `goToDefinition` on a component import in a `.ts` file lands on the
    ambient `*.svelte` module. Ask the Svelte server, from a `.svelte` file,
    for those.
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
  (<Lang>, pid <proxy pid>) joined manager pid <pid>`.
- These variables in Claude Code's environment (for example `env` in
  `settings.json`) reach the manager when a session starts it:
  - `LSP_KIT_TRACE=1` adds every message to the log.
  - `LSP_KIT_MAX_SERVERS` sets the machine-wide cap (10).
  - `LSP_KIT_IDLE_MS` sets the idle stop (10 minutes; the tests shorten it).
  - `LSP_KIT_PIPE` names a private manager; the tests give each run its own.

  A running manager keeps the values it started with: end it (its pid is in
  the log) to apply new ones.
- `node test/smoke.mjs <svelte|typescript|rust|lua> <root> <hover|references|documentSymbol|definition> <file:line:col>...`
  drives the proxy like Claude Code does, on a private manager.
- Each test below builds a throwaway project under `<scratchDir>`, runs its
  own private managers, and prints PASS/FAIL lines:
- `node test/hooks.mjs <scratchDir>` checks what the hooks add, with a
  stub TypeScript 6 (not served) and then 7.
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
- `node test/typescript.mjs <scratchDir>` installs TypeScript 7 into its
  project (npm, so the first run needs the registry or npm's cache). It checks
  definitions and references across two `.ts` files and an `.mjs` file
  importing one, that two sessions share one server, and that the manager runs
  the native binary itself. It also checks that pulled diagnostics reach the
  session as pushes (after an open, and on refresh for other open files), and
  that the TypeScript server counts toward the cap with a Lua server.
- `node test/rust.mjs <scratchDir>` checks the manager holds rust-analyzer
  itself, a worktree pinned to another installed toolchain gets that
  toolchain's server, and every server exits with the manager.
- `node test/roots.mjs <scratchDir>` checks a session started in a
  subdirectory roots Lua at the git toplevel (`.luarc.json` applies), a
  sibling worktree gets its own server, and the Lua outline.

## License

MIT
