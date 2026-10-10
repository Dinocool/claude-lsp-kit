# claude-lsp-kit

A [Claude Code](https://claude.com/claude-code) plugin that gives the LSP tool
**Svelte**, **Rust** and **Lua** language servers. It keeps them responsive in
large repos and starts separate servers for the git worktrees agents work in.

## What it fixes

The language servers run behind one small stdio proxy
(`plugins/lsp-kit/proxy.mjs`, no dependencies), which fixes four things.

**1. Whole-repo watcher fallbacks.** Claude Code's LSP client doesn't advertise
`workspace.didChangeWatchedFiles`. Without it, `svelte-language-server` starts
a chokidar watcher over the whole workspace, ignoring only `.git` and
`node_modules`. That includes agent worktrees under `.claude/worktrees`, which
are full copies of the repo. On Windows the crawl kept the server busy for
minutes, so every request timed out. The proxy tells each server the client
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

The same limits apply to every server, the session's own checkout included,
so an idle session holds no index in memory:

- a server starts on the first request for its checkout;
- at most 3 run at once per language and session, and the least recently
  used one stops first;
- a server stops after 10 minutes unused, or when its directory is deleted;
- a server that stops, crashes or is killed starts again on the next request
  for its checkout. The proxy keeps running; it exits only when Claude Code
  shuts it down, and then stops every server it started.

`workspaceSymbol` queries the session checkout's server (starting it if it
stopped) and every other running server, and merges the results, so a symbol
shows up once per running checkout. Each checkout has one server, however
the client spells its path (drive-letter case, short names). Git submodules belong to their
superproject's server; a nested clone is its own checkout. Servers run with the session
root as their working directory, so they never stop a worktree from being
removed on Windows.

Recursive `fs.watch` is native and cheap on Windows and macOS. On Linux, Node
20+ emulates it in JavaScript and watches every directory, which can hit
inotify limits in very large trees.

**4. Per-language setup.**
- **Rust:** rust-analyzer only looks for `Cargo.toml` at the root and one
  level down. The proxy finds the top-level `Cargo.toml` in every subtree and
  passes them all as `linkedProjects`, so crates like `tools/foo` or
  `app/src-tauri` get analysis. It also retries requests that get
  `ContentModified` while rust-analyzer reloads, because Claude Code doesn't.
  Under rustup, the proxy starts the toolchain's rust-analyzer directly
  (`rustup which rust-analyzer`, run in the server's checkout so its
  `rust-toolchain.toml` applies): rustup's own `rust-analyzer` is a proxy
  that runs the real server as its child, which stopping it could orphan.
- **Svelte:** the server comes from the project's `node_modules` if it's
  there, otherwise from the global install next to `node`.
- **Lua:** scope and runtime come from the project's `.luarc.json`. Without one
  bounding the workspace, LuaLS scans every file under the root. LuaLS's
  `documentSymbol` lists every local, parameter and `if` block of every
  function (1,500 entries for a 1,900-line file); the proxy trims it to an
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
  only if its project marker is present at the repo root and its server is
  installed. Markers: `svelte.config.*`, a
  `Cargo.toml`, `.luarc.json`.
- **Grep:** when the pattern is a bare identifier searched over a served
  language, a hint to use `workspaceSymbol` and `findReferences`. A Grep of
  one file gets the hint only when that file's language is served.
- **Read:** when Claude reads a file over 150 lines in a served language in
  full, a hint to get the outline with `documentSymbol` first.

Each Grep or Read adds about 0.1 s for the hook, mostly Node startup.

## Install

Install the language servers you need:

```sh
npm install -g svelte-language-server   # Svelte
rustup component add rust-analyzer      # Rust
# Lua: lua-language-server on PATH (https://github.com/LuaLS/lua-language-server/releases)
```

Then install the plugin:

```sh
claude plugin marketplace add Dinocool/claude-lsp-kit
claude plugin install lsp-kit@claude-lsp-kit
```

Run `/reload-plugins` or restart Claude Code. Disable other LSP plugins for
the same file types, such as `rust-analyzer-lsp` from the official
marketplace.

To update, after a release bumped the version in `plugin.json` and
`.claude-plugin/marketplace.json`:

```sh
claude plugin marketplace update claude-lsp-kit
claude plugin update lsp-kit@claude-lsp-kit
```

Then restart each Claude Code session: a running session keeps the proxy it
started with.

## Debugging

- `LSP_KIT_TRACE=1` in Claude Code's environment logs every proxied message to
  the server's stderr.
- Start and stop events are always logged, as `lsp-kit: <Lang> server #n for
  <root> (<n> live, pid <pid>)`.
- `LSP_KIT_IDLE_MS` overrides the 10-minute idle stop (the tests shorten it).
- `node test/smoke.mjs <svelte|rust|lua> <root> <hover|references|documentSymbol|definition> <file:line:col>...`
  drives the proxy like Claude Code does.
- Each test below builds a throwaway project under `<scratchDir>` and prints
  PASS/FAIL lines:
- `node test/hooks.mjs <scratchDir>` checks what the hooks add.
- `node test/lifecycle.mjs <scratchDir>` kills the session's and a
  worktree's server, removes a worktree while its server runs, checks the
  session's server counts toward the cap, lets it stop when idle (one server
  per checkout however a request spells it), checks that a server that can't
  start answers with the reason, and that exit and end of input stop every
  server.
- `node test/rust.mjs <scratchDir>` checks the proxy holds rust-analyzer
  itself, a worktree pinned to another installed toolchain gets that
  toolchain's server, and every server exits with the proxy.
- `node test/roots.mjs <scratchDir>` checks a session started in a
  subdirectory roots Lua at the git toplevel (`.luarc.json` applies), a
  sibling worktree gets its own server, and the Lua outline.

## License

MIT
