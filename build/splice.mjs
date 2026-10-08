// Generate <DIR>/index.ts: the converter (convert.mjs) inlined, so the extension has no file
// imports at all. Mechanical, so the mapping stays byte-identical.
//
//   node splice.mjs [DIR [OUT]]  DIR defaults to the directory holding this script; OUT defaults
//                                to <DIR>/index.ts.
//
// The input is the pre-splice source; the output is not idempotent, so never splice the output.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = process.argv[2] || dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[3] || `${DIR}/index.ts`;
const idx = readFileSync(`${DIR}/index.presplice.ts`, "utf8");
const cv = readFileSync(`${DIR}/convert.mjs`, "utf8").split("\n");

const start = cv.findIndex((l) => l === 'const HARNESS = "omp";');
const tailAt = cv.findIndex((l) => l.startsWith("// `import.meta.url` is the resolved path"));
if (start < 0 || tailAt < 0) throw new Error("convert.mjs anchors not found");

const body = cv
  .slice(start, tailAt)
  .filter((l) => !/^import .* from "node:(fs|path|url)";$/.test(l))
  .map((l) => l.replace(/^export (function|const|class|async) /, "$1 "))
  .join("\n")
  .replace(/\s+$/, "");

const oldImports = [
  'import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";',
  'import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";',
  'import { fileURLToPath } from "node:url";',
  'import { dirname, join, sep } from "node:path";',
  "",
  'import { convert, convertTree } from "./convert.mjs";',
].join("\n");
if (!idx.includes(oldImports)) throw new Error("index.ts import block not found");

const newImports = [
  'import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";',
  'import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";',
  'import { basename, dirname, join, sep } from "node:path";',
  'import { fileURLToPath } from "node:url";',
].join("\n");

const section = `// The omp -> funes turns mapping (docs/funes-jsonl.md): the one implementation, run per turn on
// the session being written and in bulk over the history \`setup\` left behind. It lives in this
// file, not beside it, because omp's extension loader resolves every file import against
// \`process.argv[1]\` — the omp binary — so no extension can reach a second module at all (probed
// 2026-10-07: static, dynamic, \`file://\` and \`createRequire\` specifiers all fail the same way).
// Node and Bun run this file as its CLI: \`node index.ts <session.jsonl | sessions-root> <spool-dir>\`.

`;

const tail = `
// The CLI \`setup\` seeds with — the same mapping, run once over the sessions root. omp loads this
// file as an extension, where argv[1] is the omp binary and this never fires.
if (process.argv[1]) {
  let self = "";
  try {
    self = realpathSync(process.argv[1]);
  } catch {}
  if (self && self === fileURLToPath(import.meta.url)) {
    const [src, spool] = process.argv.slice(2);
    if (!src || !spool) {
      console.error("usage: index.ts <session.jsonl | sessions-root> <spool-dir>");
      process.exit(2);
    }
    const written = statSync(src).isDirectory() ? convertTree(src, spool) : [convert(src, spool)];
    console.log(written.length);
  }
}
`;

const out = idx.replace(oldImports, newImports).replace(/\s+$/, "") + "\n\n" + section + body + "\n" + tail;
writeFileSync(OUT, out);
console.log(`wrote ${out.length} bytes, ${out.split("\n").length} lines; inlined ${body.split("\n").length} lines`);
