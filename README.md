# funes-omp

An [omp](https://github.com/can1357/oh-my-pi) extension that gives omp the funes
read tools and keeps the memory current as you work.

omp has no MCP client, so the extension *is* one: it spawns `funes mcp` once over
stdio, keeps it warm for the session, and forwards each call as an MCP
`tools/call`. Same `funes mcp` surface every other agent integration consumes —
just fronted by a thin omp tool. Which tools those are isn't listed here: it
registers whatever `tools/list` returns, so an omp session sees exactly the
surface of the funes binary on PATH.

omp exposes its lifecycle to extensions, so the automation rides in the same
extension: `turn_end` converts the turn just completed and indexes it, and — with
a memory bound — `session_shutdown` publishes, as does `session_start` when the
process is fresh (its other starts follow a shutdown that just published).
Nothing outside `~/.funes/agents/omp` is written by the extension itself; the
registration it asks omp for is omp's own bookkeeping, in `~/.omp/plugins/`.

## Install

Clone, then let `funes` install and register it:

```sh
git clone https://github.com/znation/funes-omp
funes add omp --from ./funes-omp          # install and register
funes add omp --from ./funes-omp acme/kb  # ... and bind a memory in the same breath
```

`funes add` extracts the extension to a fixed `~/.funes/agents/omp`, writes the
two pointers the automation reads — the `spool` directory `funes index` drains
and the `sessions` root omp writes — and registers the extension with omp.
funes's integrations catalog has no `omp` entry yet, so name where the
integration comes from: `--from` takes a directory holding it (an `hf://buckets/…`
archive works too, a git URL does not); a bare `funes add omp` stops with
`the integrations catalog lists no omp`. Re-running `funes add omp` keeps the
memory bound; `funes add omp local` unbinds it.

omp can install the package by itself as well:

```sh
omp plugin install github:znation/funes-omp
```

That is recall only. With no `spool`/`sessions` pointers beside the extension,
nothing gets converted or indexed: the read tools work, the per-turn automation
has nothing to do. This verb also shells out to `bun`, so `bun` has to be on
`PATH` — without it the command fails with
`Error: Executable not found in $PATH: "bun"` and installs nothing. So does
`omp plugin uninstall`; `omp install <dir>` and `omp plugin install <dir>` don't.

`omp install <dir>` links the directory rather than copying it, so the install
has to stay where it is.

## Remove

```sh
funes remove omp
```

Takes the extracted install with it — `~/.funes/agents/omp` and the pointers
beside it, plus the pre-registry `~/.funes/integrations/omp` if there was one.
Your memory and omp's own sessions are untouched.

omp has no unregister to call, so the registration outlives the directory: the
entry in `~/.omp/plugins/omp-plugins.lock.json`, and the `node_modules/funes-omp`
symlink `omp install` made, which is left dangling. omp tolerates both — `omp
plugin list` reports no plugins, and a later `funes add` or `omp install`
re-points the same name at the fresh install. To drop the entry anyway, `omp
plugin uninstall funes-omp` does it — it removes the symlink and leaves the lock
entry, which is equally inert — and it needs `bun` on `PATH` too.

## Requirements

- `funes` on `PATH` (set `FUNES_BIN` to override the binary path).
- A funes memory the binary can read — local, or a live `hf://` remote (needs
  network + an HF token for a private remote). Bind one with
  `funes add omp --from ./funes-omp <memory>`, or set `FUNES_MEMORY` to pin it
  explicitly
  — forwarded as the `funes mcp <memory>` positional, and used as the publish
  target.
- TruffleHog on `PATH`, or `FUNES_TRUFFLEHOG=/path/to/trufflehog`. `funes`
  refuses to push a memory to the Hub unscanned. Recall, indexing, and a local
  memory don't need it.

The extension declares no dependencies: it talks to `funes mcp` over stdio and to
omp through the extension API omp's loader provides.

## Development

`index.ts` is generated, and committed: `build/index.presplice.ts` plus the
converter in `build/convert.mjs`, inlined by `build/splice.mjs`. That isn't
cosmetic — omp's extension loader can't import a sibling module from disk, so the
extension has to arrive as one file. The same file doubles as a CLI:

```sh
index.ts <session.jsonl | sessions-root> <spool-dir>
```

```sh
npm run build   # splice into .build/ and cmp against the committed index.ts
npm run check   # build, then the test suite
sh test/run.sh  # the test suite on its own
```

`sh test/run.sh [node|bun|deno]` picks the runtime for the tests that need one;
node also needs `--experimental-strip-types`, which the script passes.
