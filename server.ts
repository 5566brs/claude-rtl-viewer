import { readdir, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
const PORT = Number(process.env.PORT ?? 5577);
const DEBOUNCE_MS = 30;

type Role = "user" | "assistant" | "tool";
interface ToolEntry { name: string; input?: unknown; }
interface Msg { uuid: string; role: Role; text: string; timestamp: string; tools?: ToolEntry[]; }
interface SessionMeta {
  path: string;
  project: string;
  mtime: number;
  preview: string;
  title?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function send(c: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) {
  try { c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
}

const AUTO_BLOCK_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g,
  /<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  /<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g,
];

function cleanUserText(text: string): string {
  for (const re of AUTO_BLOCK_PATTERNS) text = text.replace(re, "");
  return text.trim();
}

function parseLine(line: string): Msg[] {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return []; }
  if (obj.isSidechain) return [];
  // Skip meta entries (isMeta: true) — system-injected turns such as skill
  // expansions, which can be hundreds of KB and are hidden by official UIs.
  if (obj.isMeta) return [];

  if (obj.type === "user" && obj.message?.content != null) {
    const c = obj.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c.filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text).join("\n");
    }
    text = cleanUserText(text);
    if (!text) return [];
    if (/^<(ide_|command-|local-command-)/.test(text)) return [];
    return [{ uuid: obj.uuid, role: "user", text, timestamp: obj.timestamp }];
  }

  if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
    const out: Msg[] = [];
    const text = obj.message.content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text).join("\n").trim();
    if (text) out.push({ uuid: obj.uuid, role: "assistant", text, timestamp: obj.timestamp });

    const tools: ToolEntry[] = obj.message.content
      .filter((p: any) => p?.type === "tool_use" && typeof p.name === "string")
      .map((p: any) => ({ name: p.name as string, input: p.input }));
    if (tools.length) {
      out.push({
        uuid: text ? `${obj.uuid}#t` : obj.uuid,
        role: "tool",
        text: tools.map(t => t.name).join(", "),
        timestamp: obj.timestamp,
        tools,
      });
    }
    return out;
  }

  return [];
}

async function loadFile(path: string): Promise<Msg[]> {
  const buf = await Bun.file(path).arrayBuffer();
  const text = dec.decode(buf);
  const seen = new Set<string>();
  const out: Msg[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    for (const m of parseLine(line)) {
      if (!seen.has(m.uuid)) { seen.add(m.uuid); out.push(m); }
    }
  }
  return out;
}

const messageCache = new Map<string, { mtime: number; messages: Msg[] }>();

async function getMessages(path: string, mtime: number): Promise<Msg[]> {
  const cached = messageCache.get(path);
  if (cached && cached.mtime === mtime) return cached.messages;
  const messages = await loadFile(path);
  messageCache.set(path, { mtime, messages });
  return messages;
}

interface SearchHit {
  path: string;
  project: string;
  uuid: string;
  role: Role;
  timestamp: string;
  snippet: string;
  score: number;
}

function projectLabel(proj: string): string {
  return proj
    .replace(/^[A-Z]--Users-[^-]+-?/, "~/")
    .replace(/^-?Users-[^-]+-?/, "~/")
    .replace(/^-?home-[^-]+-?/, "~/")
    .replace(/-+/g, "/")
    .replace(/\/$/, "") || "~";
}

async function search(q: string, limit: number): Promise<SearchHit[]> {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const s of snapshot) {
    const projText = (projectLabel(s.project) + " " + s.project).toLowerCase();
    let messages: Msg[];
    try { messages = await getMessages(s.path, s.mtime); }
    catch { continue; }
    for (const m of messages) {
      const lower = m.text.toLowerCase();
      let totalCount = 0;
      let firstIdx = -1;
      let ok = true;
      for (const term of terms) {
        let idx = lower.indexOf(term);
        const inProj = projText.indexOf(term) !== -1;
        if (idx === -1 && !inProj) { ok = false; break; }
        if (idx !== -1) {
          if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
          while (idx !== -1) { totalCount++; idx = lower.indexOf(term, idx + term.length); }
        }
      }
      if (!ok) continue;
      let snippet: string;
      if (firstIdx === -1) {
        const head = m.text.slice(0, 220).replace(/\s+/g, " ");
        snippet = head + (m.text.length > 220 ? "…" : "");
      } else {
        const start = Math.max(0, firstIdx - 80);
        const end = Math.min(m.text.length, firstIdx + 220);
        snippet =
          (start > 0 ? "…" : "") +
          m.text.slice(start, end).replace(/\s+/g, " ") +
          (end < m.text.length ? "…" : "");
      }
      hits.push({
        path: s.path,
        project: s.project,
        uuid: m.uuid,
        role: m.role,
        timestamp: m.timestamp,
        snippet,
        score: totalCount,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || (b.timestamp || "").localeCompare(a.timestamp || ""));
  return hits.slice(0, limit);
}

async function readMeta(path: string): Promise<{ preview: string; title: string }> {
  let preview = "";
  let title = "";
  try {
    const buf = await Bun.file(path).slice(0, 256 * 1024).arrayBuffer();
    const text = dec.decode(buf);
    for (const line of text.split("\n")) {
      if (!line) continue;
      if (line.includes('"type":"ai-title"')) {
        try {
          const obj = JSON.parse(line);
          if (obj?.type === "ai-title" && typeof obj.aiTitle === "string") {
            const t = obj.aiTitle.trim();
            if (t) title = t;
          }
        } catch {}
        continue;
      }
      if (!preview) {
        for (const m of parseLine(line)) {
          if (m.role === "user") { preview = m.text.slice(0, 240); break; }
        }
      }
    }
  } catch {}
  return { preview, title };
}

const metaCache = new Map<string, { mtime: number; preview: string; title: string }>();
let snapshot: SessionMeta[] = [];

async function readSessionMeta(full: string, proj: string): Promise<SessionMeta | null> {
  let s;
  try { s = await stat(full); } catch { return null; }
  const cached = metaCache.get(full);
  let preview: string;
  let title: string;
  if (cached && cached.mtime === s.mtimeMs) {
    preview = cached.preview;
    title = cached.title;
  } else {
    const m = await readMeta(full);
    preview = m.preview;
    title = m.title;
    metaCache.set(full, { mtime: s.mtimeMs, preview, title });
  }
  const meta: SessionMeta = { path: full, project: proj, mtime: s.mtimeMs, preview };
  if (title) meta.title = title;
  return meta;
}

async function initialScan(): Promise<void> {
  let projects: string[];
  try { projects = await readdir(PROJECTS_DIR); } catch { snapshot = []; return; }
  const list: SessionMeta[] = [];
  for (const proj of projects) {
    const dir = join(PROJECTS_DIR, proj);
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const meta = await readSessionMeta(join(dir, f), proj);
      if (meta) list.push(meta);
    }
  }
  list.sort((a, b) => b.mtime - a.mtime);
  snapshot = list;
}

interface Sub {
  controller: ReadableStreamDefaultController<Uint8Array>;
  mode: "latest" | "pinned";
  pinned?: string;
  current: string | null;
  lastSize: number;
  seen: Set<string>;
}

const subs = new Set<Sub>();

async function processSub(sub: Sub, latest: string | null) {
  const target = sub.mode === "latest" ? latest : sub.pinned ?? null;
  if (!target) return;

  if (target !== sub.current) {
    const messages = await loadFile(target);
    let size = 0;
    try { size = (await stat(target)).size; } catch {}
    sub.current = target;
    sub.lastSize = size;
    sub.seen = new Set(messages.map(m => m.uuid));
    send(sub.controller, "reset", { file: target, mode: sub.mode, messages });
    return;
  }

  let s;
  try { s = await stat(target); } catch { return; }
  if (s.size < sub.lastSize) {
    const messages = await loadFile(target);
    sub.lastSize = s.size;
    sub.seen = new Set(messages.map(m => m.uuid));
    send(sub.controller, "reset", { file: target, mode: sub.mode, messages });
    return;
  }
  if (s.size === sub.lastSize) return;

  const slice = await Bun.file(target).slice(sub.lastSize, s.size).arrayBuffer();
  sub.lastSize = s.size;
  const text = dec.decode(slice);
  for (const line of text.split("\n")) {
    if (!line) continue;
    for (const m of parseLine(line)) {
      if (!sub.seen.has(m.uuid)) {
        sub.seen.add(m.uuid);
        send(sub.controller, "append", m);
      }
    }
  }
}

function broadcastSessions() {
  for (const sub of subs) send(sub.controller, "sessions", snapshot);
}

async function syncFile(full: string, proj: string): Promise<boolean> {
  const meta = await readSessionMeta(full, proj);
  const idx = snapshot.findIndex(x => x.path === full);
  if (!meta) {
    if (idx < 0) return false;
    snapshot.splice(idx, 1);
    messageCache.delete(full);
    metaCache.delete(full);
    return true;
  }
  if (idx >= 0) {
    const prev = snapshot[idx];
    if (prev.mtime === meta.mtime && prev.preview === meta.preview && prev.title === meta.title) return false;
    snapshot[idx] = meta;
  } else {
    snapshot.push(meta);
  }
  snapshot.sort((a, b) => b.mtime - a.mtime);
  return true;
}

async function handleChange(relPath: string) {
  const norm = relPath.replace(/\\/g, "/");
  if (!norm.endsWith(".jsonl")) return;
  const proj = norm.split("/")[0];
  if (!proj) return;
  const full = join(PROJECTS_DIR, relPath);

  const prevLatest = snapshot[0]?.path ?? null;
  const changed = await syncFile(full, proj);
  const latest = snapshot[0]?.path ?? null;

  if (changed) broadcastSessions();

  for (const sub of subs) {
    const target = sub.mode === "latest" ? latest : sub.pinned ?? null;
    const isAffected =
      target === full ||
      (sub.mode === "latest" && latest !== prevLatest);
    if (!isAffected) continue;
    try { await processSub(sub, latest); }
    catch (err) { console.error("sub error:", err); }
  }
}

// ---------- live agents (persistent Claude Code process per conversation) ----------
// Architecture mirrors the official surfaces (VS Code extension, Claude in
// Chrome, Remote Control): exactly ONE long-lived process owns the session
// while it's being driven from the viewer, and the web UI is a frontend that
// feeds input into that process. The Agent SDK spawns the Claude Code CLI
// locally, so auth is whatever the user's CLI already has (subscription OAuth
// or API key) — the server never touches credentials.
//
// Division of labor:
//  - The live process is the channel for INPUT (user messages), PERMISSION
//    prompts (canUseTool → browser approve/deny), and live token STREAMING
//    (partial_assistant events → `stream` SSE, rendered as a ghost bubble).
//  - The DISK pipeline (watcher → reset/append) stays canonical for content:
//    history, sessions written by other tools (terminal / VS Code), search,
//    and the durable final form of every streamed message.

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_IDLE_REAP_MS = 30 * 60 * 1000;  // close idle processes after 30 min
const PERM_TIMEOUT_MS = 10 * 60 * 1000;     // auto-deny unanswered prompts

interface PendingPerm {
  id: string;
  tool: string;
  input: unknown;
  resolve: (r: unknown) => void;
  done: boolean;
}

interface Agent {
  file: string;
  sessionId: string;
  cwd: string;
  q: any;                       // SDK Query (AsyncGenerator + control methods)
  queue: any[];                 // pending SDKUserMessages
  wake: (() => void) | null;    // resumes the input generator
  state: "working" | "idle";
  closed: boolean;
  lastActivity: number;
  lastError: string | null;
  stderrTail: string;
  permSeq: number;
  pendingPerms: Map<string, PendingPerm>;
}

const agents = new Map<string, Agent>();
const startingAgents = new Map<string, Promise<Agent>>();

function broadcastAgent(file: string, state: string, error?: string | null) {
  for (const sub of subs) send(sub.controller, "agent", { file, state, error: error ?? null });
}
function broadcastPerm(file: string, payload: Record<string, unknown>) {
  for (const sub of subs) send(sub.controller, "perm", { file, ...payload });
}
// Stream deltas are chatty — only push them to subs actually watching the file.
function broadcastStream(file: string, payload: Record<string, unknown>) {
  for (const sub of subs) {
    if (sub.current === file) send(sub.controller, "stream", { file, ...payload });
  }
}

// The CLI must run from the session's original working directory so resume
// finds the session under the matching project folder.
async function readSessionCwd(path: string): Promise<string | null> {
  try {
    const buf = await Bun.file(path).slice(0, 256 * 1024).arrayBuffer();
    const text = dec.decode(buf);
    for (const line of text.split("\n")) {
      if (!line || !line.includes('"cwd"')) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj?.cwd === "string" && obj.cwd) return obj.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

// Input side of the live process: an async generator the SDK consumes. New
// user messages are pushed into `queue`; `wake` un-parks the generator.
// Setting `closed` and waking ends the generator, which closes the CLI's
// stdin and shuts the process down gracefully.
async function* agentInput(agent: Agent) {
  while (!agent.closed) {
    while (agent.queue.length) yield agent.queue.shift();
    if (agent.closed) break;
    await new Promise<void>(resolve => { agent.wake = resolve; });
    agent.wake = null;
  }
}

function resolvePerm(agent: Agent, id: string, allow: boolean, message?: string): boolean {
  const perm = agent.pendingPerms.get(id);
  if (!perm || perm.done) return false;
  perm.done = true;
  agent.pendingPerms.delete(id);
  broadcastPerm(agent.file, { id, state: "resolved", allow });
  // On allow, updatedInput MUST echo the original input — the CLI replaces the
  // tool's input with this value, so omitting it runs the tool with no input.
  perm.resolve(allow
    ? { behavior: "allow", updatedInput: perm.input }
    : { behavior: "deny", message: message || "Denied from the viewer" });
  return true;
}

function handlePermissionAsk(agent: Agent, toolName: string, input: Record<string, unknown>, opts: any): Promise<unknown> {
  return new Promise(resolve => {
    const id = `perm-${++agent.permSeq}`;
    const perm: PendingPerm = { id, tool: toolName, input, resolve, done: false };
    agent.pendingPerms.set(id, perm);
    broadcastPerm(agent.file, { id, state: "ask", tool: toolName, input });

    const timer = setTimeout(() => {
      resolvePerm(agent, id, false, "permission request timed out in the viewer");
    }, PERM_TIMEOUT_MS);
    const origResolve = perm.resolve;
    perm.resolve = (r) => { clearTimeout(timer); origResolve(r); };

    opts?.signal?.addEventListener?.("abort", () => {
      resolvePerm(agent, id, false, "aborted");
    });
  });
}

function handleStreamEvent(agent: Agent, ev: any) {
  if (!ev || typeof ev.type !== "string") return;
  if (ev.type === "content_block_start") {
    const block = ev.content_block ?? {};
    broadcastStream(agent.file, { kind: "block-start", blockType: block.type ?? "", name: block.name ?? "" });
  } else if (ev.type === "content_block_delta") {
    const delta = ev.delta ?? {};
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      broadcastStream(agent.file, { kind: "text", text: delta.text });
    }
    // thinking/tool-input deltas are intentionally not forwarded — the viewer
    // doesn't render thinking, and tool inputs arrive via the disk pipeline.
  } else if (ev.type === "content_block_stop") {
    broadcastStream(agent.file, { kind: "block-end" });
  }
}

async function runAgentLoop(agent: Agent) {
  try {
    for await (const msg of agent.q) {
      agent.lastActivity = Date.now();
      if (msg.type === "stream_event" || msg.type === "partial_assistant") {
        // field name differs across SDK versions: `event` vs `stream_event`
        handleStreamEvent(agent, msg.stream_event ?? msg.event);
        continue;
      }
      if (msg.type === "assistant" || msg.type === "user") {
        if (agent.state !== "working") {
          agent.state = "working";
          broadcastAgent(agent.file, "working");
        }
        continue; // content reaches clients through the disk pipeline
      }
      if (msg.type === "result") {
        agent.state = "idle";
        agent.lastError = msg.subtype === "success"
          ? null
          : (Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join("; ") : msg.subtype);
        broadcastStream(agent.file, { kind: "turn-end" });
        broadcastAgent(agent.file, agent.lastError ? "error" : "idle", agent.lastError);
      }
    }
    // generator finished (deliberate close)
    if (!agent.lastError) broadcastAgent(agent.file, "gone");
  } catch (err) {
    agent.lastError = `${err}`.slice(0, 500) + (agent.stderrTail ? ` · ${agent.stderrTail.slice(-300)}` : "");
    console.error(`agent loop failed for ${agent.file}:`, agent.lastError);
    broadcastAgent(agent.file, "error", agent.lastError);
  } finally {
    agent.closed = true;
    agent.wake?.();
    for (const perm of [...agent.pendingPerms.values()]) {
      resolvePerm(agent, perm.id, false, "agent closed");
    }
    if (agents.get(agent.file) === agent) agents.delete(agent.file);
  }
}

async function getOrCreateAgent(file: string): Promise<Agent | { error: string; status: number }> {
  const existing = agents.get(file);
  if (existing && !existing.closed) return existing;
  const starting = startingAgents.get(file);
  if (starting) return starting;

  if (!snapshot.some(s => s.path === file)) return { error: "unknown session file", status: 404 };
  const name = file.replace(/\\/g, "/").split("/").pop() ?? "";
  const sessionId = name.replace(/\.jsonl$/i, "");
  if (!SESSION_ID_RE.test(sessionId)) return { error: "not a resumable session", status: 422 };

  const promise = (async (): Promise<Agent> => {
    const cwd = await readSessionCwd(file);
    if (!cwd) throw Object.assign(new Error("session has no cwd record"), { status: 422 });

    const agent: Agent = {
      file, sessionId, cwd,
      q: null, queue: [], wake: null,
      state: "idle", closed: false,
      lastActivity: Date.now(), lastError: null, stderrTail: "",
      permSeq: 0, pendingPerms: new Map(),
    };
    agent.q = query({
      prompt: agentInput(agent),
      options: {
        resume: sessionId,
        cwd,
        executable: "bun",
        includePartialMessages: true,
        permissionMode: "default",
        stderr: (d: string) => { agent.stderrTail = (agent.stderrTail + d).slice(-2000); },
        canUseTool: (tool: string, input: Record<string, unknown>, opts: any) =>
          handlePermissionAsk(agent, tool, input, opts),
      },
    });
    agents.set(file, agent);
    runAgentLoop(agent);
    return agent;
  })();

  startingAgents.set(file, promise);
  try {
    return await promise;
  } catch (err: any) {
    return { error: err?.message ?? `${err}`, status: err?.status ?? 500 };
  } finally {
    startingAgents.delete(file);
  }
}

function closeAgent(agent: Agent) {
  agent.closed = true;
  agent.wake?.();
}

// Reap processes that have been idle for a long time so the server doesn't
// accumulate CLI processes for every conversation ever touched.
setInterval(() => {
  const now = Date.now();
  for (const agent of agents.values()) {
    if (agent.state === "idle" && agent.pendingPerms.size === 0 && now - agent.lastActivity > AGENT_IDLE_REAP_MS) {
      closeAgent(agent);
    }
  }
}, 5 * 60 * 1000);

async function readJsonBody(req: Request): Promise<any | null> {
  try { return await req.json(); } catch { return null; }
}

async function handleSend(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const file = typeof body?.file === "string" ? body.file : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!file || !text) return Response.json({ error: "missing file or text" }, { status: 400 });

  const agent = await getOrCreateAgent(file);
  if (!(agent as Agent).q) {
    const e = agent as { error: string; status: number };
    return Response.json({ error: e.error }, { status: e.status });
  }
  const a = agent as Agent;
  a.queue.push({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: a.sessionId,
  });
  a.lastActivity = Date.now();
  a.wake?.();
  a.state = "working";
  broadcastAgent(file, "working");
  return Response.json({ ok: true });
}

async function handlePermissionResponse(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const file = typeof body?.file === "string" ? body.file : "";
  const id = typeof body?.id === "string" ? body.id : "";
  const allow = body?.allow === true;
  const agent = agents.get(file);
  if (!agent) return Response.json({ error: "no live agent for this session" }, { status: 404 });
  const message = typeof body?.message === "string" && body.message ? body.message : undefined;
  if (!resolvePerm(agent, id, allow, message)) {
    return Response.json({ error: "unknown or already-resolved permission request" }, { status: 404 });
  }
  agent.lastActivity = Date.now();
  return Response.json({ ok: true });
}

async function handleInterrupt(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const file = typeof body?.file === "string" ? body.file : "";
  const agent = agents.get(file);
  if (!agent || agent.closed) return Response.json({ error: "no live agent for this session" }, { status: 404 });
  try { await agent.q.interrupt(); } catch (err) {
    return Response.json({ error: `interrupt failed: ${err}` }, { status: 500 });
  }
  agent.lastActivity = Date.now();
  return Response.json({ ok: true });
}

const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleChange(relPath: string) {
  const existing = pendingChanges.get(relPath);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingChanges.delete(relPath);
    handleChange(relPath).catch(err => console.error("handleChange:", err));
  }, DEBOUNCE_MS);
  pendingChanges.set(relPath, t);
}

await initialScan();

try {
  const watcher = watch(PROJECTS_DIR, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    const name = typeof filename === "string" ? filename : filename.toString();
    if (!name.endsWith(".jsonl")) return;
    scheduleChange(name);
  });
  watcher.on("error", err => console.error("watcher error:", err));
} catch (err) {
  console.error(`watcher failed for ${PROJECTS_DIR}:`, err);
}

const HTML_PATH = new URL("./index.html", import.meta.url);
async function loadHtml(): Promise<string> {
  return await Bun.file(HTML_PATH).text();
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-allow-private-network": "true",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return loadHtml().then(html => withCors(new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      })));
    }

    if (url.pathname === "/api/sessions") {
      return withCors(Response.json(snapshot));
    }

    if (url.pathname === "/api/send" && req.method === "POST") {
      return handleSend(req).then(withCors);
    }

    if (url.pathname === "/api/permission" && req.method === "POST") {
      return handlePermissionResponse(req).then(withCors);
    }

    if (url.pathname === "/api/interrupt" && req.method === "POST") {
      return handleInterrupt(req).then(withCors);
    }

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 60)));
      return search(q, limit).then(hits => withCors(Response.json(hits)));
    }

    if (url.pathname === "/events") {
      const file = url.searchParams.get("file");
      const sub: Sub = {
        controller: null!,
        mode: file ? "pinned" : "latest",
        pinned: file ?? undefined,
        current: null,
        lastSize: 0,
        seen: new Set(),
      };
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          sub.controller = c;
          subs.add(sub);
          send(c, "ready", { mode: sub.mode, pinned: sub.pinned ?? null });
          send(c, "sessions", snapshot);
          const latest = snapshot[0]?.path ?? null;
          processSub(sub, latest)
            .then(() => {
              // Late joiners need the current live-agent state for their target
              // (e.g. a reload while Claude is mid-turn or waiting on a prompt).
              const target = sub.current;
              const agent = target ? agents.get(target) : null;
              if (agent && !agent.closed) {
                send(c, "agent", { file: agent.file, state: agent.lastError ? "error" : agent.state, error: agent.lastError });
                for (const perm of agent.pendingPerms.values()) {
                  send(c, "perm", { file: agent.file, id: perm.id, state: "ask", tool: perm.tool, input: perm.input });
                }
              }
            })
            .catch(err => console.error("init sub:", err));
        },
        cancel() { subs.delete(sub); },
      });
      return withCors(new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        },
      }));
    }

    return withCors(new Response("not found", { status: 404 }));
  },
});

console.log(`claude-rtl-viewer → http://localhost:${PORT}`);
console.log(`watching: ${PROJECTS_DIR}`);
