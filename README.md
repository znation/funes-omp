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
Nothing outside `~/.funes/agents/omp` is configured.

## Install

Install the package directly with omp, user-wide:

```sh
omp plugin install github:znation/funes-omp
```

Once `funes` is on your PATH, `funes add` does the same thing and wires up the
automation: it extracts the extension to a fixed `~/.funes/agents/omp` and
registers it with omp.

```sh
funes add omp --from ./          # this checkout
funes add omp --from ./ acme/kb  # ... and bind a memory in the same breath
```

funes's integrations catalog has no `omp` entry yet, so name where the
integration comes from with `--from <DIR|URL>`; a bare `funes add omp` stops with
`the integrations catalog lists no omp`. Re-running `funes add omp` keeps the
memory bound; `funes add omp local` unbinds it.

## Remove

```sh
funes remove omp
```

Unregisters the extension and takes the whole install with it. Your memory and
omp's own sessions are untouched. If you installed it with omp alone,
`omp plugin uninstall funes-omp` removes just the registration.

## Requirements

- `funes` on `PATH` (set `FUNES_BIN` to override the binary path).
- A funes memory the binary can read — local, or a live `hf://` remote (needs
  network + an HF token for a private remote). Bind one with
  `funes add omp --from ./ <memory>`, or set `FUNES_MEMORY` to pin it explicitly
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
