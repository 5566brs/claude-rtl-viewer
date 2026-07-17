import { readdir, stat, access, mkdir } from "node:fs/promises";
import { watch, constants as fsConstants } from "node:fs";
import { join, dirname, resolve as resolvePath, sep as pathSep } from "node:path";
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
const PORT = Number(process.env.PORT ?? 5577);
const DEBOUNCE_MS = 30;

type Role = "user" | "assistant" | "tool";
interface ToolEntry { name: string; input?: unknown; id?: string; }
interface Msg { uuid: string; role: Role; text: string; timestamp: string; tools?: ToolEntry[]; }
interface SessionMeta {
  path: string;
  project: string;
  mtime: number;
  preview: string;
  title?: string;
  cwd?: string;  // real working directory from the .jsonl (unambiguous path, unlike the mangled `project` folder name)
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

// `sidechain: true` is used when parsing a subagent transcript, where every
// line is isSidechain by definition; main-session parsing keeps dropping them.
function parseLine(line: string, opts?: { sidechain?: boolean }): Msg[] {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return []; }
  if (obj.isSidechain && !opts?.sidechain) return [];
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

  // Queued input: a message the user typed while the agent was mid-turn is
  // persisted as an `attachment` (subtype "queued_command"), NOT as a normal
  // `type:"user"` entry — without this branch it vanishes from the transcript.
  // Gate on commandMode === "prompt": the sibling mode "task-notification"
  // carries system `<task-notification>` blocks (background-task completions),
  // not user input, and would otherwise render as fake user messages. Anything
  // that still slips in as a tag (e.g. `<ide_opened_file>`) is caught by the
  // shared cleanUserText + guard below. The dequeued prompt is fed to the model
  // but not re-logged as a user turn, so there's no duplicate to guard against.
  if (
    obj.type === "attachment" &&
    obj.attachment?.type === "queued_command" &&
    obj.attachment.commandMode === "prompt"
  ) {
    const p = obj.attachment.prompt;
    let text = "";
    if (typeof p === "string") text = p;
    else if (Array.isArray(p)) {
      text = p.filter((x: any) => x?.type === "text" && typeof x.text === "string")
        .map((x: any) => x.text).join("\n");
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
      .map((p: any) => {
        const t: ToolEntry = { name: p.name as string, input: p.input };
        // The id links an Agent call to its subagent transcript on disk.
        if (typeof p.id === "string") t.id = p.id;
        return t;
      });
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

async function loadFile(path: string, opts?: { sidechain?: boolean }): Promise<Msg[]> {
  const buf = await Bun.file(path).arrayBuffer();
  const text = dec.decode(buf);
  const seen = new Set<string>();
  const out: Msg[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    for (const m of parseLine(line, opts)) {
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
  uuid: string;       // representative (highest-count) message, for scroll-to
  role: Role;
  timestamp: string;
  snippet: string;
  score: number;      // total term occurrences across the whole session (also used as `count`)
  count: number;      // total term occurrences in this session — shown in the UI
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
    const projText = (projectLabel(s.project) + " " + s.project + " " + (s.cwd ?? "")).toLowerCase();
    let messages: Msg[];
    try { messages = await getMessages(s.path, s.mtime); }
    catch { continue; }
    // One hit per session: sum term occurrences across all matching messages, and
    // keep the highest-count message as the representative snippet / scroll target.
    let sessionCount = 0;
    let best: { score: number; snippet: string; uuid: string; role: Role; timestamp: string } | null = null;
    let fallback: { snippet: string; uuid: string; role: Role; timestamp: string } | null = null;
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
      sessionCount += totalCount;
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
      if (!fallback) fallback = { snippet, uuid: m.uuid, role: m.role, timestamp: m.timestamp };
      if (firstIdx !== -1 && (!best || totalCount > best.score)) {
        best = { score: totalCount, snippet, uuid: m.uuid, role: m.role, timestamp: m.timestamp };
      }
    }
    const rep = best ?? fallback;
    if (!rep) continue;  // no message matched (all terms lived only in projText but no message qualified)
    hits.push({
      path: s.path,
      project: s.project,
      uuid: rep.uuid,
      role: rep.role,
      timestamp: rep.timestamp,
      snippet: rep.snippet,
      score: sessionCount,
      count: sessionCount,
    });
  }
  hits.sort((a, b) => b.score - a.score || (b.timestamp || "").localeCompare(a.timestamp || ""));
  return hits.slice(0, limit);
}

async function readMeta(path: string): Promise<{ preview: string; title: string; cwd: string }> {
  let preview = "";
  let title = "";
  let cwd = "";
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
      if (!cwd && line.includes('"cwd"')) {
        try {
          const obj = JSON.parse(line);
          if (typeof obj?.cwd === "string" && obj.cwd) cwd = obj.cwd;
        } catch {}
      }
      if (!preview) {
        for (const m of parseLine(line)) {
          if (m.role === "user") { preview = m.text.slice(0, 240); break; }
        }
      }
    }
  } catch {}
  return { preview, title, cwd };
}

const metaCache = new Map<string, { mtime: number; preview: string; title: string; cwd: string }>();
let snapshot: SessionMeta[] = [];

async function readSessionMeta(full: string, proj: string): Promise<SessionMeta | null> {
  let s;
  try { s = await stat(full); } catch { return null; }
  const cached = metaCache.get(full);
  let preview: string;
  let title: string;
  let cwd: string;
  if (cached && cached.mtime === s.mtimeMs) {
    preview = cached.preview;
    title = cached.title;
    cwd = cached.cwd;
  } else {
    const m = await readMeta(full);
    preview = m.preview;
    title = m.title;
    cwd = m.cwd;
    metaCache.set(full, { mtime: s.mtimeMs, preview, title, cwd });
  }
  const meta: SessionMeta = { path: full, project: proj, mtime: s.mtimeMs, preview };
  if (title) meta.title = title;
  if (cwd) meta.cwd = cwd;
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
  const payload = clientSnapshot();
  for (const sub of subs) send(sub.controller, "sessions", payload);
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

  // A just-spawned "new chat" session writing its first lines — bind the
  // waiting agent to this file so /api/new can return and routing kicks in.
  const pendingNew = pendingNewAgents.get(fileSessionId(full));
  if (pendingNew) adoptNewAgent(pendingNew, full);

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
// How long /api/new waits for the fresh CLI process to reveal its session id
// (and for the .jsonl to land so we can hand the client a file to pin to).
const NEW_SESSION_IDENTIFY_MS = 25 * 1000;

// Permission modes we surface to the viewer — the same cycle Claude Code's
// Shift+Tab walks. `query()`'s options.permissionMode and Query.setPermissionMode
// both accept these. (`dontAsk`/`auto` exist in the SDK but aren't exposed here.)
type PermMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
const VALID_MODES = new Set<PermMode>(["default", "acceptEdits", "plan", "bypassPermissions"]);
function asMode(v: unknown): PermMode | null {
  return typeof v === "string" && VALID_MODES.has(v as PermMode) ? (v as PermMode) : null;
}

interface PendingPerm {
  id: string;
  tool: string;
  input: unknown;
  resolve: (r: unknown) => void;
  done: boolean;
}

interface Agent {
  file: string;                 // "" until a new session is identified
  sessionId: string;            // "" until a new session is identified
  cwd: string;
  permissionMode: PermMode;
  q: any;                       // SDK Query (AsyncGenerator + control methods)
  queue: any[];                 // pending SDKUserMessages
  wake: (() => void) | null;    // resumes the input generator
  state: "working" | "idle";
  // Sub-status while working, from the SDK's authoritative signals:
  // "running" | "requesting" | "compacting" | "requires_action" | null.
  activity: string | null;
  closed: boolean;
  lastActivity: number;
  lastError: string | null;
  stderrTail: string;
  permSeq: number;
  pendingPerms: Map<string, PendingPerm>;
  // For freshly-spawned sessions: resolves once the session id + on-disk file
  // are known, so /api/new can hand the client a file to pin to.
  identifyResolve: ((file: string | null) => void) | null;
}

const agents = new Map<string, Agent>();
const startingAgents = new Map<string, Promise<Agent>>();
// Desired permission mode per session file, set by the viewer. Read at agent
// creation and applied live to a running agent. Survives reaping so a re-spawn
// remembers the user's last choice.
const pendingModes = new Map<string, PermMode>();
// Fresh sessions whose id is known but whose .jsonl hasn't been matched to a
// snapshot entry yet — keyed by session id, adopted by the watcher.
const pendingNewAgents = new Map<string, Agent>();

// Sessions started FROM the viewer ("new chat"). ONLY these get the live
// composer. Resuming a session another process owns (VS Code / terminal) would
// fork the conversation — two processes appending to one .jsonl, each sending
// the API its own divergent history. We sidestep that by only ever driving
// sessions we created. Persisted so ownership survives restarts and reaping.
const OWNED_FILE = join(dirname(PROJECTS_DIR), ".rtl-viewer-owned.json");
const ownedSessions = new Set<string>();
async function loadOwned() {
  try {
    const arr = JSON.parse(await Bun.file(OWNED_FILE).text());
    if (Array.isArray(arr)) for (const id of arr) if (typeof id === "string") ownedSessions.add(id);
  } catch {}
}
function saveOwned() {
  Bun.write(OWNED_FILE, JSON.stringify([...ownedSessions])).catch(err => console.error("saveOwned:", err));
}
function markOwned(sessionId: string) {
  if (!sessionId || ownedSessions.has(sessionId)) return;
  ownedSessions.add(sessionId);
  saveOwned();
}
function isOwnedFile(file: string): boolean {
  return ownedSessions.has(fileSessionId(file));
}

// Decorate the snapshot with the per-session `owned` flag the client uses to
// decide whether to show the composer.
function clientSnapshot() {
  return snapshot.map(s => ({ ...s, owned: ownedSessions.has(fileSessionId(s.path)) }));
}

function modeForFile(file: string): PermMode {
  return agents.get(file)?.permissionMode ?? pendingModes.get(file) ?? "default";
}
function broadcastAgent(file: string, state: string, error?: string | null) {
  const mode = modeForFile(file);
  const activity = agents.get(file)?.activity ?? null;
  for (const sub of subs) send(sub.controller, "agent", { file, state, error: error ?? null, mode, activity });
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

// The session id is the .jsonl's basename; the watcher hands us full paths.
function fileSessionId(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return name.replace(/\.jsonl$/i, "");
}

// Build the SDK Query for an agent and start consuming it. `resume` is the
// session id for an existing conversation; omit it to spawn a brand-new session
// (the CLI mints a fresh id and writes a new .jsonl under PROJECTS_DIR).
function startAgentQuery(agent: Agent, resume?: string) {
  agent.q = query({
    prompt: agentInput(agent),
    options: {
      ...(resume ? { resume } : {}),
      cwd: agent.cwd,
      executable: "bun",
      includePartialMessages: true,
      permissionMode: agent.permissionMode,
      stderr: (d: string) => { agent.stderrTail = (agent.stderrTail + d).slice(-2000); },
      canUseTool: (tool: string, input: Record<string, unknown>, opts: any) =>
        handlePermissionAsk(agent, tool, input, opts),
    },
  });
  runAgentLoop(agent);
}

function newAgent(file: string, sessionId: string, cwd: string, mode: PermMode): Agent {
  return {
    file, sessionId, cwd, permissionMode: mode,
    q: null, queue: [], wake: null,
    state: "idle", activity: null, closed: false,
    lastActivity: Date.now(), lastError: null, stderrTail: "",
    permSeq: 0, pendingPerms: new Map(), identifyResolve: null,
  };
}

// A fresh session's .jsonl has appeared (or was already in the snapshot): bind
// the agent to its file, register it for routing, and release /api/new.
function adoptNewAgent(agent: Agent, file: string) {
  if (agent.file === file) return;
  agent.file = file;
  agents.set(file, agent);
  pendingNewAgents.delete(agent.sessionId);
  if (agent.permissionMode !== "default") pendingModes.set(file, agent.permissionMode);
  if (agent.identifyResolve) { const r = agent.identifyResolve; agent.identifyResolve = null; r(file); }
  // Now that the file is known, surface current state + any prompts that fired
  // before identification to whichever sub ends up pinned to this file.
  broadcastAgent(file, agent.lastError ? "error" : agent.state, agent.lastError);
  for (const perm of agent.pendingPerms.values()) {
    if (!perm.done) broadcastPerm(file, { id: perm.id, state: "ask", tool: perm.tool, input: perm.input });
  }
}

// Called the first time a new session reveals its id. If the .jsonl already
// landed, adopt immediately; otherwise wait for the watcher to spot it. This
// only ever fires for sessions WE spawned (no resume), so the id is ours to own.
function identifyNewAgent(agent: Agent, sessionId: string) {
  agent.sessionId = sessionId;
  markOwned(sessionId);
  const existing = snapshot.find(s => fileSessionId(s.path) === sessionId);
  if (existing) adoptNewAgent(agent, existing.path);
  else pendingNewAgents.set(sessionId, agent);
}

async function runAgentLoop(agent: Agent) {
  try {
    for await (const msg of agent.q) {
      agent.lastActivity = Date.now();
      // A freshly-spawned session announces its id on the first message of any
      // type; capture it so the watcher can bind this agent to its .jsonl.
      if (!agent.sessionId && typeof msg.session_id === "string" && msg.session_id) {
        identifyNewAgent(agent, msg.session_id);
      }
      if (msg.type === "stream_event" || msg.type === "partial_assistant") {
        // field name differs across SDK versions: `event` vs `stream_event`
        handleStreamEvent(agent, msg.stream_event ?? msg.event);
        continue;
      }
      // Authoritative state straight from the CLI — the reliable "is it working"
      // signal (mirrors notifySessionStateChanged). `session_state_changed.state`
      // is idle | running | requires_action; `status` carries compacting/requesting
      // while running. These drive the working indicator instead of guessing from
      // message arrival.
      if (msg.type === "system") {
        if (msg.subtype === "session_state_changed") {
          if (msg.state === "idle") { agent.state = "idle"; agent.activity = null; }
          else { agent.state = "working"; agent.activity = msg.state === "requires_action" ? "requires_action" : "running"; }
          broadcastAgent(agent.file, agent.lastError ? "error" : agent.state, agent.lastError);
        } else if (msg.subtype === "status" && msg.status) {
          agent.state = "working";
          agent.activity = msg.status; // "compacting" | "requesting"
          broadcastAgent(agent.file, agent.lastError ? "error" : agent.state, agent.lastError);
        }
        continue;
      }
      if (msg.type === "assistant" || msg.type === "user") {
        if (agent.state !== "working") {
          agent.state = "working";
          if (!agent.activity) agent.activity = "running";
          broadcastAgent(agent.file, "working");
        }
        continue; // content reaches clients through the disk pipeline
      }
      if (msg.type === "result") {
        agent.state = "idle";
        agent.activity = null;
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
    if (agent.sessionId) pendingNewAgents.delete(agent.sessionId);
    // Unblock a still-waiting /api/new with whatever file we managed to learn.
    if (agent.identifyResolve) { const r = agent.identifyResolve; agent.identifyResolve = null; r(agent.file || null); }
    if (agent.file && agents.get(agent.file) === agent) agents.delete(agent.file);
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
  // Only drive sessions we started — resuming one another process owns (VS Code /
  // terminal) would fork the conversation. Such sessions are read-only here.
  if (!ownedSessions.has(sessionId)) {
    return { error: "read-only: this conversation was not started from the viewer", status: 403 };
  }

  const promise = (async (): Promise<Agent> => {
    const cwd = await readSessionCwd(file);
    if (!cwd) throw Object.assign(new Error("session has no cwd record"), { status: 422 });

    const agent = newAgent(file, sessionId, cwd, pendingModes.get(file) ?? "default");
    agents.set(file, agent);
    startAgentQuery(agent, sessionId);
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

// Apply a mode to a running process. Throws if the SDK refuses (e.g. switching
// an already-running session to bypassPermissions, which the CLI only allows
// when launched with --dangerously-skip-permissions) — callers decide whether
// that's fatal. permissionMode is only updated once the switch actually takes.
async function applyMode(agent: Agent, mode: PermMode): Promise<void> {
  if (agent.permissionMode === mode) return;
  await agent.q.setPermissionMode(mode);
  agent.permissionMode = mode;
}

async function handleSend(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const file = typeof body?.file === "string" ? body.file : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!file || !text) return Response.json({ error: "missing file or text" }, { status: 400 });

  // Honor a mode chosen alongside the message — recorded before creation so a
  // fresh agent spawns with it, and applied live to an existing one.
  const reqMode = asMode(body?.mode);
  if (reqMode) pendingModes.set(file, reqMode);

  const agent = await getOrCreateAgent(file);
  if (!(agent as Agent).q) {
    const e = agent as { error: string; status: number };
    return Response.json({ error: e.error }, { status: e.status });
  }
  const a = agent as Agent;
  // Best-effort: if the switch is refused (e.g. bypass on a running session) the
  // message still goes through in the agent's current mode — don't fail the send.
  if (reqMode) { try { await applyMode(a, reqMode); } catch (err) { console.error("applyMode (send):", err); } }
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

// Set the permission mode for a conversation. Recorded for the next spawn and
// applied live if a process is already running. No agent is created here —
// toggling the mode shouldn't spin up a CLI on its own.
async function handleMode(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const file = typeof body?.file === "string" ? body.file : "";
  const mode = asMode(body?.mode);
  if (!file || !mode) return Response.json({ error: "missing file or invalid mode" }, { status: 400 });
  // Mode only applies to sessions the viewer drives.
  if (!isOwnedFile(file)) return Response.json({ error: "read-only session" }, { status: 403 });
  const agent = agents.get(file);
  if (agent && !agent.closed) {
    // A running process must actually accept the switch. bypassPermissions on an
    // already-running session is refused by the CLI — report it so the viewer can
    // revert the button instead of showing a mode the agent isn't really in.
    try { await applyMode(agent, mode); }
    catch (err) {
      return Response.json({ error: String((err as any)?.message || err), mode: agent.permissionMode }, { status: 409 });
    }
    pendingModes.set(file, mode);
    agent.lastActivity = Date.now();
    broadcastAgent(file, agent.lastError ? "error" : agent.state, agent.lastError);
    return Response.json({ ok: true, mode });
  }
  // No live process yet — record the choice; the next spawn launches with it
  // (bypassPermissions works fine when set at launch, only not mid-session).
  pendingModes.set(file, mode);
  return Response.json({ ok: true, mode });
}

function parentDir(p: string): string | null {
  const up = dirname(p);
  return up && up !== p ? up : null;
}

// Subagent transcripts (Agent-tool sidechains) live in a directory named after
// the session: <project>/<session-id>/subagents/agent-*.jsonl, with a sibling
// agent-*.meta.json whose `toolUseId` links the transcript back to the Agent
// tool_use in the main .jsonl. This resolves a tool_use id to the parsed
// transcript so the client can show the subagent's conversation — including
// its final report, which never renders from the main file (tool_results are
// dropped by design there).
async function handleSubagent(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const file = url.searchParams.get("file") ?? "";
  const id = url.searchParams.get("id") ?? "";
  // `file` must be a known session — this also blocks path traversal (we never
  // touch the filesystem from a client-supplied path that isn't in the snapshot).
  if (!snapshot.some(s => s.path === file)) {
    return Response.json({ error: "unknown session file" }, { status: 404 });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return Response.json({ error: "bad tool_use id" }, { status: 400 });
  }
  const subDir = join(file.replace(/\.jsonl$/i, ""), "subagents");
  let entries: string[];
  try { entries = await readdir(subDir); } catch {
    return Response.json({ error: "no subagent transcripts for this session" }, { status: 404 });
  }
  for (const name of entries) {
    if (!name.endsWith(".meta.json")) continue;
    let meta: any;
    try { meta = JSON.parse(await Bun.file(join(subDir, name)).text()); } catch { continue; }
    if (meta?.toolUseId !== id) continue;
    const transcript = join(subDir, name.replace(/\.meta\.json$/, ".jsonl"));
    let messages: Msg[];
    try { messages = await loadFile(transcript, { sidechain: true }); } catch {
      return Response.json({ error: "subagent transcript unreadable" }, { status: 404 });
    }
    return Response.json({
      messages,
      agentType: typeof meta.agentType === "string" ? meta.agentType : null,
      description: typeof meta.description === "string" ? meta.description : null,
    });
  }
  return Response.json({ error: "subagent transcript not found" }, { status: 404 });
}

// Folder browser for "new chat": list the sub-directories of `path` (defaults
// to the user's home) so the viewer can walk the real filesystem and pick a
// working directory. Errors come back 200 with an `error` field + the resolved
// path so the modal can show the message and still offer the parent to go back.
async function handleDirs(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("path") ?? "").trim();
  const target = raw ? resolvePath(raw) : homedir();
  let entries: any[];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (err: any) {
    const msg = err?.code === "ENOENT" ? "folder not found"
      : err?.code === "EACCES" || err?.code === "EPERM" ? "permission denied"
      : "cannot read folder";
    return Response.json({ error: msg, path: target, parent: parentDir(target), sep: pathSep, dirs: [] });
  }
  const dirs = entries
    .filter(e => { try { return e.isDirectory(); } catch { return false; } })
    .map(e => ({ name: e.name, path: join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  return Response.json({ path: target, parent: parentDir(target), sep: pathSep, dirs });
}

// Create a sub-folder inside `path` (so the user can make a fresh working dir
// from the new-chat browser without leaving for a file manager). `name` must be
// a single safe path segment.
async function handleMkdir(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const parent = typeof body?.path === "string" ? body.path.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!parent || !name) return Response.json({ error: "missing path or name" }, { status: 400 });
  if (name === "." || name === ".." || /[\\/:*?"<>|]/.test(name)) {
    return Response.json({ error: "invalid folder name" }, { status: 400 });
  }
  const base = resolvePath(parent);
  try {
    const st = await stat(base);
    if (!st.isDirectory()) return Response.json({ error: "not a directory" }, { status: 400 });
  } catch { return Response.json({ error: "parent folder does not exist" }, { status: 400 }); }
  const full = join(base, name);
  try {
    await mkdir(full);
  } catch (err: any) {
    if (err?.code === "EEXIST") return Response.json({ error: "folder already exists" }, { status: 409 });
    if (err?.code === "EACCES" || err?.code === "EPERM") return Response.json({ error: "permission denied" }, { status: 403 });
    return Response.json({ error: `could not create folder: ${err?.code || err}` }, { status: 500 });
  }
  return Response.json({ ok: true, path: full });
}

// Start a BRAND-NEW conversation in `cwd`: spawn a fresh CLI (no resume) with
// the first message, wait for it to reveal its session id and for the watcher
// to bind the new .jsonl, then hand the client a file to pin to. Disk stays
// canonical — the new session flows through watcher → reset/append like any other.
async function handleNew(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const cwdRaw = typeof body?.cwd === "string" ? body.cwd.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const mode = asMode(body?.mode) ?? "default";
  if (!cwdRaw) return Response.json({ error: "missing cwd" }, { status: 400 });
  if (!text) return Response.json({ error: "missing text" }, { status: 400 });

  const cwd = resolvePath(cwdRaw);
  try {
    const st = await stat(cwd);
    if (!st.isDirectory()) return Response.json({ error: "cwd is not a directory" }, { status: 400 });
  } catch { return Response.json({ error: "folder does not exist" }, { status: 400 }); }
  try { await access(cwd, fsConstants.W_OK); }
  catch { return Response.json({ error: "no write permission for this folder" }, { status: 403 }); }

  const agent = newAgent("", "", cwd, mode);
  const identified = new Promise<string | null>(resolve => {
    agent.identifyResolve = resolve;
    setTimeout(() => {
      if (agent.identifyResolve) { const r = agent.identifyResolve; agent.identifyResolve = null; r(agent.file || null); }
    }, NEW_SESSION_IDENTIFY_MS);
  });
  startAgentQuery(agent);   // no resume → the CLI mints a fresh session
  agent.queue.push({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  });
  agent.wake?.();
  agent.state = "working";

  const file = await identified;
  if (!file) {
    if (!agent.closed) closeAgent(agent);
    return Response.json({ error: "could not start the new session (timed out)" }, { status: 504 });
  }
  return Response.json({ ok: true, file, sessionId: agent.sessionId });
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

// <project>/<session-id>/subagents/agent-*.jsonl → full path of the parent
// session's .jsonl, or null if the path isn't subagent-shaped.
function subagentMainFile(relPath: string): string | null {
  const m = relPath.replace(/\\/g, "/").match(/^([^/]+)\/([^/]+)\/subagents\/[^/]+\.jsonl$/);
  return m ? join(PROJECTS_DIR, m[1], `${m[2]}.jsonl`) : null;
}

// Debounced like scheduleChange. Content is fetched on demand via /api/subagent;
// this only pings subs viewing the parent session so an open thread can refresh.
const pendingSubagentPings = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleSubagentPing(mainFile: string) {
  const existing = pendingSubagentPings.get(mainFile);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingSubagentPings.delete(mainFile);
    for (const sub of subs) {
      if (sub.current === mainFile) send(sub.controller, "subagent", { file: mainFile });
    }
  }, DEBOUNCE_MS);
  pendingSubagentPings.set(mainFile, t);
}

await loadOwned();
await initialScan();

try {
  const watcher = watch(PROJECTS_DIR, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    const name = typeof filename === "string" ? filename : filename.toString();
    if (!name.endsWith(".jsonl")) return;
    // Only .jsonl files directly under a project folder are sessions. Deeper
    // ones (e.g. <session-id>/subagents/agent-*.jsonl) must not reach syncFile —
    // they'd enter the snapshot as phantom empty sessions (initialScan never
    // sees them, so they'd also vanish on restart).
    if (name.replace(/\\/g, "/").split("/").length !== 2) {
      const main = subagentMainFile(name);
      if (main) scheduleSubagentPing(main);
      return;
    }
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
      return withCors(Response.json(clientSnapshot()));
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

    if (url.pathname === "/api/mode" && req.method === "POST") {
      return handleMode(req).then(withCors);
    }

    if (url.pathname === "/api/new" && req.method === "POST") {
      return handleNew(req).then(withCors);
    }

    if (url.pathname === "/api/subagent") {
      return handleSubagent(req).then(withCors);
    }

    if (url.pathname === "/api/dirs") {
      return handleDirs(req).then(withCors);
    }

    if (url.pathname === "/api/mkdir" && req.method === "POST") {
      return handleMkdir(req).then(withCors);
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
          send(c, "sessions", clientSnapshot());
          const latest = snapshot[0]?.path ?? null;
          processSub(sub, latest)
            .then(() => {
              // Late joiners need the current live-agent state for their target
              // (e.g. a reload while Claude is mid-turn or waiting on a prompt).
              const target = sub.current;
              const agent = target ? agents.get(target) : null;
              if (agent && !agent.closed) {
                send(c, "agent", { file: agent.file, state: agent.lastError ? "error" : agent.state, error: agent.lastError, mode: agent.permissionMode, activity: agent.activity });
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
