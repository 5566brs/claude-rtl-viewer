import { readdir, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

async function search(q: string, limit: number): Promise<SearchHit[]> {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const s of snapshot) {
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
        if (idx === -1) { ok = false; break; }
        if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
        while (idx !== -1) { totalCount++; idx = lower.indexOf(term, idx + term.length); }
      }
      if (!ok) continue;
      const start = Math.max(0, firstIdx - 80);
      const end = Math.min(m.text.length, firstIdx + 220);
      const snippet =
        (start > 0 ? "…" : "") +
        m.text.slice(start, end).replace(/\s+/g, " ") +
        (end < m.text.length ? "…" : "");
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

async function readPreview(path: string): Promise<string> {
  try {
    const buf = await Bun.file(path).slice(0, 32 * 1024).arrayBuffer();
    const text = dec.decode(buf);
    for (const line of text.split("\n")) {
      if (!line) continue;
      for (const m of parseLine(line)) {
        if (m.role === "user") return m.text.slice(0, 240);
      }
    }
  } catch {}
  return "";
}

const previewCache = new Map<string, { mtime: number; preview: string }>();
let snapshot: SessionMeta[] = [];

async function readSessionMeta(full: string, proj: string): Promise<SessionMeta | null> {
  let s;
  try { s = await stat(full); } catch { return null; }
  const cached = previewCache.get(full);
  let preview: string;
  if (cached && cached.mtime === s.mtimeMs) {
    preview = cached.preview;
  } else {
    preview = await readPreview(full);
    previewCache.set(full, { mtime: s.mtimeMs, preview });
  }
  return { path: full, project: proj, mtime: s.mtimeMs, preview };
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
    previewCache.delete(full);
    return true;
  }
  if (idx >= 0) {
    const prev = snapshot[idx];
    if (prev.mtime === meta.mtime && prev.preview === meta.preview) return false;
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
  "access-control-allow-methods": "GET, OPTIONS",
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
          processSub(sub, latest).catch(err => console.error("init sub:", err));
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
