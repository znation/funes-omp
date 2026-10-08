#!/bin/sh
# Every test of the omp bundle: the generated extension, the converter, the extension's startup, and
# `setup`.
#
# The converter's acceptance test: a real omp session, trimmed and secret-scanned, and the turns file
# it must produce. `expected.funes.jsonl` is what funes's own parser emitted for this session while
# it had one — the `harness` tag is the only thing this bundle's converter changes — so a change that
# moves a chunk id re-keys sessions users already hold.
#
#   sh test/run.sh [node|bun|deno]
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
JS=${1:-node}
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT INT TERM

# index.ts is generated — omp's extension loader cannot import a sibling module from disk, so the
# converter is inlined into it — and a fresh splice has to reproduce the committed file byte for
# byte, or the shipped extension is not what its sources say.
"$JS" "$HERE/../build/splice.mjs" "$HERE/../build" "$out/index.ts" >/dev/null
if ! cmp "$out/index.ts" "$HERE/../index.ts"; then
    echo "omp bundle: index.ts is not what build/splice.mjs produces — regenerate it" >&2
    exit 1
fi
echo "omp bundle: ok"

"$JS" "$HERE/../build/convert.mjs" "$HERE/session.jsonl" "$out"
if ! diff -u "$HERE/expected.funes.jsonl" "$out/session.funes.jsonl"; then
    echo "omp converter: output changed — see the diff above" >&2
    exit 1
fi
# To the second: the runtime stamps to the millisecond, and ordering the spool needs no more.
if ! "$JS" "$HERE/same-second.mjs" "$out/session.funes.jsonl" "$HERE/session.jsonl"; then
    echo "omp converter: the turns file does not carry the session's own time" >&2
    exit 1
fi
echo "omp converter: ok"

# The extension's startup, run as omp runs it: node strips the types itself from 22.18 on; bun and
# deno always did.
case "$JS" in
node) TS=--experimental-strip-types ;;
*) TS= ;;
esac
if ! "$JS" $TS "$HERE/startup.mjs"; then
    echo "omp startup: a history setup left pending is not indexed at the next start — see above" >&2
    exit 1
fi
echo "omp startup: ok"

sh "$HERE/setup.sh"
