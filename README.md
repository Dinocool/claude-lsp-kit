# claude-svelte-lsp

A [Claude Code](https://claude.com/claude-code) plugin that gives the LSP tool
`svelte-language-server` for `.svelte` files and keeps it responsive in large
workspaces.

## Why another Svelte LSP plugin

Claude Code's LSP client doesn't advertise `workspace.didChangeWatchedFiles`.
Without that capability, `svelte-language-server` starts a chokidar watcher over
the whole workspace, and it only ignores `.git` and `node_modules`. In a big
repo this watcher crawls everything: agent worktrees under `.claude/worktrees`,
data folders and build output. On Windows that keeps the server busy for
minutes, so every LSP request hits Claude Code's 60 s timeout.

This plugin starts the server behind a small stdio proxy (`proxy.mjs`, no
dependencies). The proxy:

- tells the server on `initialize` that the client reports file changes, so
  the chokidar fallback never starts;
- answers the server's `client/registerCapability` request for watched files
  itself;
- watches each workspace root with one native recursive `fs.watch`, skipping
  `node_modules` and dot-directories except `.svelte-kit`, and passes changes
  on in batches as `workspace/didChangeWatchedFiles`;
- starts the server with the same `node` binary, so it needs no `cmd /c`
  workaround on Windows.

Every other message passes through unchanged.

In one 230k-file SvelteKit repo, the first `documentSymbol` came back in
**1.8 s**. Without the proxy it had still not answered after 280 s.

The plugin also ships hooks that point Claude to the LSP. They only add
context and never block a tool call:

- **SessionStart:** in a Svelte project (one with a `svelte.config.*`), a short
  note on what the LSP answers better than text search.
- **Grep:** when the pattern is a bare identifier searched over JS, TS or
  Svelte files, a hint to use `workspaceSymbol`, `findReferences` and
  `goToDefinition` instead.
- **Read:** when Claude reads a `.svelte` file over 150 lines in full, a hint
  to get the outline with `documentSymbol` and read only the ranges it needs.

## Install

```sh
npm install -g svelte-language-server
claude plugin marketplace add Dinocool/claude-svelte-lsp
claude plugin install svelte-lsp@claude-svelte-lsp
```

Then run `/reload-plugins` or restart Claude Code.

The proxy looks for `svelte-language-server` in the project's `node_modules`
first. If it isn't there, it uses the global install that belongs to the
`node` on your `PATH`.

## License

MIT
