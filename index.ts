// funes-owned omp extension: expose recall over past AI-assistant sessions as
// first-class omp tools, and index each turn into the local memory.
//
// omp has no MCP client of its own, so this extension *is* the client: it spawns
// `funes mcp` once over stdio, keeps it warm for the session, and forwards each
// call as an MCP `tools/call`. That keeps the embedder + reranker loaded across
// calls (unlike shelling out to `funes recall`, which reloads both every time),
// and it consumes the same `funes mcp` surface every other agent integration uses.
//
// The tools aren't written out here: the extension registers whatever
// `tools/list` returns, passing each MCP schema through as omp's `parameters` —
// so there is no second copy of the surface to keep in step.
//
// Install: `funes add omp` — or `omp -e <this directory>` for a single run.
//
// `funes` is taken from PATH; set FUNES_BIN to override the binary. FUNES_BIN and
// FUNES_MEMORY are generic environment overrides funes honors; a host that embeds
// funes sets them from the outside. This extension knows nothing of such a host —
// only of the vars.
//
// The memory this extension recalls from — and publishes to — is resolved once, in order:
//   1. FUNES_MEMORY in the environment (a per-run override, set by whatever host)
//   2. the memory bound at install by `funes add omp <memory>`, saved in a `memory`
//      file next to this extension (absent = the local memory)
// The result is forwarded as the `funes mcp <memory>` positional; empty forwards a
// bare `funes mcp` (the local memory).
//
// omp's lifecycle events carry no `reason` — the probe run of 2026-10-07 saw bare
// `{"type":"session_start"}` and `{"type":"session_shutdown"}` payloads — so the
// pi guards on `event.reason` are gone and both boundaries publish unconditionally:
// `session_start` fires once per session start and `session_shutdown` once at
// disposal. omp's own switch/branch events are not this extension's concern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNES_BIN = process.env.FUNES_BIN || "funes";

// A file `funes add omp` wrote beside this extension, or "" when there is none.
function bound(name: string): string {
  try {
    return readFileSync(join(HERE, name), "utf8").trim();
  } catch {
    return "";
  }
}

// The directory funes drains for this bundle, resolved at install: funes hands `setup` its home and
// this agent's id, neither of which reaches a running extension.
const SPOOL = bound("spool");
// Where omp kept its sessions when `setup` ran: `~/.omp/agent/sessions`, one directory per project
// under it.
const SESSIONS = bound("sessions");
// The sessions root `setup` could not convert for want of a JS runtime, left for omp's own.
const SEED_PENDING = join(HERE, "seed-pending");

const memory = (process.env.FUNES_MEMORY || bound("memory")).trim();
const FUNES_ARGS = memory ? ["mcp", memory] : ["mcp"];
// funes and omp, as funes's Hub requests name them: hf-hub appends
// HF_HUB_USER_AGENT_ORIGIN to its User-Agent. An origin already set is kept in front.
const HUB_ORIGIN = [process.env.HF_HUB_USER_AGENT_ORIGIN, "funes; agent/omp"];
function funesEnv() {
  return { ...process.env, HF_HUB_USER_AGENT_ORIGIN: HUB_ORIGIN.filter(Boolean).join("; ") };
}
const PROTOCOL_VERSION = "2024-11-05"; // matches funes' rmcp server
const CALL_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 10_000; // omp's startup waits on these, so they don't get a recall's bound

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };

// A minimal MCP stdio client for a single `funes mcp` child. stdout is the
// JSON-RPC channel (newline-delimited messages); stderr is logs.
class FunesMcp {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";

  private ensureStarted(): Promise<void> {
    if (this.child && this.ready) return this.ready;
    const child = spawn(FUNES_BIN, FUNES_ARGS, { env: funesEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    // The server is kept warm for the whole session, so unref it (and its pipes)
    // — an in-flight call's timer keeps the loop alive, but once the agent's turn
    // is done nothing should. Without this the idle child pins the host's event
    // loop open and the turn never exits.
    // Bun's `child.stdin` is a FileSink with no `unref` (Node's is a socket and has one), so
    // guard each handle rather than assuming the Node shape.
    for (const handle of [child, child.stdin, child.stdout, child.stderr] as any[]) {
      try {
        if (typeof handle?.unref === "function") handle.unref();
      } catch {}
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.resume(); // drain logs so the pipe never blocks
    const die = (err: Error) => {
      this.child = undefined;
      this.ready = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };
    child.on("exit", (code) => die(new Error(`funes mcp exited (code ${code})`)));
    child.on("error", (e) => die(new Error(`funes mcp failed to start: ${e.message}`)));
    // A write to a child that has just exited fails on the pipe, ahead of the exit itself; unheard,
    // that error would take the host down.
    child.stdin.on("error", (e) => die(new Error(`funes mcp went away: ${e.message}`)));

    const start = (async () => {
      try {
        await this.request(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "omp-funes-bridge", version: "0.1.0" },
          },
          undefined,
          HANDSHAKE_TIMEOUT_MS,
        );
        this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      } catch (err: any) {
        // Initialize failed while the child may still be alive (e.g. it timed out): tear it
        // down so the next call respawns instead of re-awaiting this rejected promise forever.
        if (this.ready === start) {
          this.child?.kill();
          this.child = undefined;
          this.ready = undefined;
        }
        throw err;
      }
    })();
    this.ready = start;
    return start;
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a JSON-RPC frame (stray output)
      }
      const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  private send(obj: any) {
    if (!this.child) throw new Error("funes mcp not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  private request(method: string, params: any, signal?: AbortSignal, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const settle = (err: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        reject(err);
      };
      const timer = setTimeout(() => settle(new Error(`funes ${method} timed out`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // A cancelled turn releases its call here instead of holding the event loop until the timeout.
      signal?.addEventListener("abort", () => settle(new Error(`funes ${method} cancelled`)), { once: true });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err: any) {
        settle(err);
      }
    });
  }

  // The tools this funes binary exposes, as MCP declares them.
  async listTools(): Promise<McpTool[]> {
    await this.ensureStarted();
    const result = await this.request("tools/list", {}, undefined, HANDSHAKE_TIMEOUT_MS);
    return (result?.tools ?? []) as McpTool[];
  }

  // Call an MCP tool and flatten its text content to a string.
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    await this.ensureStarted();
    const result = await this.request("tools/call", { name, arguments: args }, signal);
    const content: any[] = result?.content ?? [];
    return content
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
}

const funes = new FunesMcp();

// The automation beside this extension: the index per turn, the publish at a boundary. It serves
// the spool `funes add omp` recorded; a run from a checkout has none, and spawns nothing.
const INDEX_SH = join(HERE, "scripts", "funes-index.sh");

// Run the automation detached and forget it: no failure of its is worth disturbing the session with.
function runScript(script: string, ...args: string[]) {
  if (!SPOOL || !existsSync(script)) return;
  try {
    // Through `sh`, the one shell a box running omp is promised.
    const child = spawn("sh", [script, ...args], { env: funesEnv(), detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// The session omp is writing, as a turns file in the spool, returning its path. Inline rather than
// detached: it is a read and an atomic write, and the file has to exist before the indexer is
// spawned. An ephemeral session (`--no-session`) has no file and nothing to convert.
function convertSession(ctx: any): string {
  if (!SPOOL) return "";
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (file) {
      convert(file, SPOOL);
      return file;
    }
  } catch {}
  return "";
}

// The sessions changed since the last sweep: those an omp that died mid-turn never converted. What
// the spool holds cannot say which those are (funes drains it), so the sweep keeps its own mark: the
// previous sweep's stamp, or, before there is one, the `spool` record `setup add` wrote just before
// it converted the history. The session in progress was converted already and is skipped.
const SWEPT = join(HERE, "swept");
function convertStale(file: string) {
  if (!SPOOL || !file) return;
  try {
    const since = statSync(existsSync(SWEPT) ? SWEPT : join(HERE, "spool")).mtimeMs;
    // Stamped before the sweep, so a session written while it runs is swept again next turn.
    const now = Date.now() / 1000;
    convertTree(sweepRoot(file), SPOOL, since, file);
    writeFileSync(SWEPT, "");
    utimesSync(SWEPT, now, now);
  } catch {}
}

// Where the sweep looks for the sessions the last one missed: the root `setup` found, when the
// session in progress is under it; else the session's own directory — omp writes into a directory
// per project under `~/.omp/agent/sessions`, but a `--session-dir` puts sessions straight in one,
// and a walk any higher would take in files that are not sessions at all.
function sweepRoot(file: string): string {
  return SESSIONS && file.startsWith(SESSIONS + sep) ? SESSIONS : dirname(file);
}

// Convert the history `setup` left behind, once, and say whether it did. Failure keeps the marker,
// so the next start retries.
function seedPending(): boolean {
  if (!SPOOL || !existsSync(SEED_PENDING)) return false;
  try {
    convertTree(readFileSync(SEED_PENDING, "utf8").trim(), SPOOL);
    rmSync(SEED_PENDING);
    return true;
  } catch {
    return false;
  }
}

export default async function (pi: any) {
  let tools: McpTool[] = [];
  let failure = "";
  try {
    tools = await funes.listTools();
  } catch (e: any) {
    failure = `funes recall is unavailable: ${e?.message || String(e)}`;
  }

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: `funes ${tool.name}`,
      description: tool.description ?? "",
      parameters: tool.inputSchema,
      execute: async (_id: string, params: Record<string, unknown>, signal?: AbortSignal) => {
        try {
          return { content: [{ type: "text", text: await funes.callTool(tool.name, params, signal) }], details: {} };
        } catch (e: any) {
          return { content: [{ type: "text", text: `${tool.name} error: ${e?.message || String(e)}` }], details: {} };
        }
      },
    });
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    if (failure) ctx?.ui?.notify(failure, "warning"); // at load it would land inside omp's own startup
    // Every omp start is a start: a fresh process is the one boundary with no shutdown behind it, so
    // it catches up whatever a process that never shut down cleanly left unpublished — and whatever
    // `setup` could not convert, seeded first so the worker's index takes it in: the publish indexes
    // before it pushes.
    const seeded = seedPending();
    if (memory) runScript(INDEX_SH, "--publish", memory);
    else if (seeded) runScript(INDEX_SH);
  });

  // Per turn, so a session killed mid-flight is indexed up to its last completed turn.
  pi.on("turn_end", async (_event: any, ctx: any) => {
    convertStale(convertSession(ctx));
    runScript(INDEX_SH);
  });

  // omp disposes the session once, so this is the last boundary there is: publish whatever the
  // turns left in the spool.
  pi.on("session_shutdown", async (_event: any) => {
    if (memory) runScript(INDEX_SH, "--publish", memory);
  });
}

// The omp -> funes turns mapping (docs/funes-jsonl.md): the one implementation, run per turn on
// the session being written and in bulk over the history `setup` left behind. It lives in this
// file, not beside it, because omp's extension loader resolves every file import against
// `process.argv[1]` — the omp binary — so no extension can reach a second module at all (probed
// 2026-10-07: static, dynamic, `file://` and `createRequire` specifiers all fail the same way).
// Node and Bun run this file as its CLI: `node index.ts <session.jsonl | sessions-root> <spool-dir>`.

const HARNESS = "omp";
const FORMAT = 1;

// Unicode White_Space, which is what Rust's `str::trim` tests. JS's own `trim` differs on two code
// points — it trims U+FEFF and does not trim U+0085 — and a block is kept or dropped on this test.
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const BLANK = new RegExp(`^[${WS}]*$`);
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const isBlank = (s) => BLANK.test(s);
const rustTrim = (s) => s.replace(TRIM, "");

// An unpaired surrogate, which only a `\uD800`-`\uDFFF` escape can introduce. serde_json rejects
// such a line outright and funes drops it; JSON.parse accepts it.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAYBE_LONE = /\\u[dD]/;

function hasLoneSurrogate(v) {
  if (typeof v === "string") return LONE.test(v);
  if (Array.isArray(v)) return v.some(hasLoneSurrogate);
  if (v && typeof v === "object") {
    return Object.keys(v).some((k) => LONE.test(k) || hasLoneSurrogate(v[k]));
  }
  return false;
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
// `Value::as_str`: a string, else nothing.
const str = (v) => (typeof v === "string" ? v : undefined);

/** Every parseable JSON object of a JSONL file, in file order (`jsonl::read_jsonl_records`). */
function readRecords(path) {
  const records = [];
  for (let line of readFileSync(path, "utf8").split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1); // Rust's `str::lines`
    line = rustTrim(line);
    if (line === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // a partial trailing write
    }
    if (MAYBE_LONE.test(line) && hasLoneSurrogate(value)) continue;
    records.push(value);
  }
  return records;
}

/** A `text`/`thinking` block, or nothing when the text is blank. */
function textLike(blockType, text) {
  return isBlank(text) ? undefined : { block_type: blockType, text };
}

/** A `toolCall` part as a tool_use block; `arguments` compacted, a missing one as `{}`. */
function toolUseBlock(part) {
  const block = {
    block_type: "tool_use",
    text: JSON.stringify("arguments" in part ? part.arguments : {}),
  };
  const name = str(part.name);
  if (name !== undefined) block.tool_name = name;
  const id = str(part.id);
  if (id !== undefined) block.tool_use_id = id;
  return block;
}

/** A tool result's `content` — a string, or a list of `{type:"text",text}` parts — as one string. */
function flattenToolResult(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (isObject(c)) {
      if (c.type === "text") parts.push(str(c.text) ?? "");
    } else if (typeof c === "string") {
      parts.push(c);
    }
  }
  return parts.join("\n");
}

function blocksOf(role, msg) {
  const content = Array.isArray(msg.content) ? msg.content : undefined;
  if (role === "user") {
    if (!content) return [];
    const blocks = [];
    for (const part of content) {
      if (!isObject(part) || part.type !== "text") continue;
      const b = textLike("text", str(part.text) ?? "");
      if (b) blocks.push(b);
    }
    return blocks;
  }
  if (role === "assistant") {
    if (!content) return [];
    const blocks = [];
    for (const part of content) {
      if (!isObject(part)) continue;
      if (part.type === "thinking") {
        const b = textLike("thinking", str(part.thinking) ?? "");
        if (b) blocks.push(b);
      } else if (part.type === "text") {
        const b = textLike("text", str(part.text) ?? "");
        if (b) blocks.push(b);
      } else if (part.type === "toolCall") {
        blocks.push(toolUseBlock(part));
      }
    }
    return blocks;
  }
  if (role === "toolResult") {
    const text = flattenToolResult(msg.content);
    if (isBlank(text)) return [];
    const block = { block_type: "tool_result", text };
    const name = str(msg.toolName);
    if (name !== undefined) block.tool_name = name;
    const id = str(msg.toolCallId);
    if (id !== undefined) block.tool_use_id = id;
    return [block];
  }
  return [];
}

/**
 * A record's `timestamp` as the format wants it. omp writes an ISO string; a pre-v2 session wrote
 * epoch milliseconds, which `.funes.jsonl` cannot carry as a number of digits — that line would
 * reject the whole file — so it is rendered as the instant it names.
 */
function timestamp(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return "";
}

function turnsOf(sessionPath, sessionId) {
  // funes rejects a `session_id` or `turn_uuid` carrying a `:` (docs/funes-jsonl.md), and the
  // rejection takes the whole file with it.
  const id = sessionId.replace(/:/g, "_");
  const records = readRecords(sessionPath);
  const header = records.find((r) => isObject(r) && r.type === "session");
  const cwd = header ? str(header.cwd) : undefined;

  const turns = [];
  let seq = 0;
  for (const record of records) {
    if (!isObject(record) || record.type !== "message") continue;
    const msg = record.message;
    if (!isObject(msg)) continue;
    const nativeRole = str(msg.role) ?? "";
    const blocks = blocksOf(nativeRole, msg);
    if (blocks.length === 0) continue;

    // Field order is the wire order of funes's own Turn.
    const turn = { format: FORMAT, session_id: id };
    if (cwd !== undefined) turn.cwd = cwd;
    turn.turn_uuid = str(record.id) ?? "";
    const parent = str(record.parentId);
    if (parent !== undefined) turn.parent_uuid = parent;
    turn.seq = seq++;
    turn.ts = timestamp(record.timestamp);
    turn.role = nativeRole === "toolResult" ? "tool" : nativeRole;
    turn.blocks = blocks;
    turn.harness = HARNESS;
    turns.push(turn);
  }
  return turns;
}

/** One session into `<spool>/<stem>.funes.jsonl`; returns the path written. */
function convert(sessionPath, outArg) {
  const stem = basename(sessionPath).replace(/\.jsonl$/, "");
  const out = outArg.endsWith(".funes.jsonl") ? outArg : join(outArg, `${stem}.funes.jsonl`);
  const body = turnsOf(sessionPath, stem)
    .map((t) => JSON.stringify(t) + "\n")
    .join("");
  // Atomic, and the temporary name is not a `.jsonl` one, so a concurrent `funes index` over the
  // spool never lists it.
  const tmp = `${out}.tmp${process.pid}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(tmp, body);
  // Stamped with the session's own time, so funes drains the spool newest session first rather
  // than in the order the seed happened to convert them.
  const { atime, mtime } = statSync(sessionPath);
  utimesSync(tmp, atime, mtime);
  renameSync(tmp, out);
  return out;
}

/** Every session under a `~/.omp/agent/sessions` tree into the spool — with `since` (epoch ms), only
 * those written after it, and never `except`. */
function convertTree(root, spool, since = 0, except = "") {
  const written = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return written; // a directory that cannot be listed holds no session of omp's
  }
  for (const entry of entries) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) written.push(...convertTree(p, spool, since, except));
    else if (entry.name.endsWith(".jsonl") && p !== except) {
      // One session that cannot be read costs its own capture, not everyone else's: the next
      // sweep meets it again if it changes.
      try {
        if (!since || statSync(p).mtimeMs > since) written.push(convert(p, spool));
      } catch {}
    }
  }
  return written;
}

// The CLI `setup` seeds with — the same mapping, run once over the sessions root. omp loads this
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
