# claude-lsp-kit

A [Claude Code](https://claude.com/claude-code) plugin that gives the LSP tool
**Svelte**, **Rust** and **Lua** language servers. It keeps them responsive in
large repos and starts separate servers for the git worktrees agents work in.

## What it fixes

The language servers run behind one small stdio proxy
(`plugins/lsp-kit/proxy.mjs`, no dependencies), which fixes three things.

**1. Whole-repo watcher fallbacks.** Claude Code's LSP client doesn't advertise
`workspace.didChangeWatchedFiles`. Without it, `svelte-language-server` starts
a chokidar watcher over the whole workspace, ignoring only `.git` and
`node_modules`. That includes agent worktrees under `.claude/worktrees`, which
are full copies of the repo. On Windows the crawl kept the server busy for
minutes, so every request timed out. The proxy tells each server the client
reports file changes. It then watches each server's root itself with one
native recursive `fs.watch`, skipping dot-directories, `node_modules` and
`target`. Changes reach the server in batches.

**2. Worktrees.** Agents edit code in git worktrees nested in the session
directory. The proxy sends each file to a server rooted at its own git
worktree: the nearest directory below the session root that holds a `.git`
entry. An agent's hover, definitions and references therefore reflect its
worktree's code, not main's. Limits:

- worktree servers start on first use;
- at most 3 run at once, and the least recently used one stops first;
- a worktree server stops after 10 minutes unused, or when its directory is
  deleted.

`workspaceSymbol` queries every live server and merges the results, so a
symbol shows up once per live worktree. Git submodules and nested clones are
not worktrees and stay with the session's server. Servers run with the session
root as their working directory, so they never stop a worktree from being
removed on Windows.

Recursive `fs.watch` is native and cheap on Windows and macOS. On Linux, Node
20+ emulates it in JavaScript and watches every directory, which can hit
inotify limits in very large trees.

**3. Per-language setup.**
- **Rust:** rust-analyzer only looks for `Cargo.toml` at the root and one
  level down. The proxy finds the top-level `Cargo.toml` in every subtree and
  passes them all as `linkedProjects`, so crates like `tools/foo` or
  `app/src-tauri` get analysis. It also retries requests that get
  `ContentModified` while rust-analyzer reloads, because Claude Code doesn't.
- **Svelte:** the server comes from the project's `node_modules` if it's
  there, otherwise from the global install next to `node`.
- **Lua:** scope and runtime come from the project's `.luarc.json`. Without one
  bounding the workspace, LuaLS scans every file under the root.

If a server isn't installed, `initialize` fails with a message that names it.

## Hooks: advertise the LSP and use it

The plugin's hooks only add context and never block a tool call:

- **SessionStart / SubagentStart:** lists the languages the LSP tool serves in
  this project, then explains when to use `documentSymbol`, `goToDefinition`,
  `findReferences`, `hover`, call hierarchy and `workspaceSymbol` instead of
  Grep or whole-file Read. A language is listed only if its project marker is
  present and its server is installed. Markers: `svelte.config.*`, a
  `Cargo.toml`, `.luarc.json`.
- **Grep:** when the pattern is a bare identifier searched over a served
  language, a hint to use `workspaceSymbol`, `findReferences` and
  `goToDefinition`.
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

## Debugging

- `LSP_KIT_TRACE=1` in Claude Code's environment logs every proxied message to
  the server's stderr.
- Start and stop events are always logged, as `lsp-kit: <Lang> server #n for
  <root>`.
- `node test/smoke.mjs <svelte|rust|lua> <root> <hover|references|documentSymbol|definition> <file:line:col>...`
  drives the proxy like Claude Code does.
- `node test/hooks.mjs <root> [largeFile]` prints what the hooks would add.

## License

MIT
