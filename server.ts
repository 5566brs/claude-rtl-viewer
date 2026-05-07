import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const PROJECTS_DIR = "C:/Users/eli/.claude/projects";
const PORT = Number(process.env.PORT ?? 5577);
const POLL_MS = 400;

type Role = "user" | "assistant";
interface Msg { uuid: string; role: Role; text: string; timestamp: string; }
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

function parseLine(line: string): Msg | null {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj.isSidechain) return null;

  if (obj.type === "user" && obj.message?.content != null) {
    const c = obj.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c.filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text).join("\n");
    }
    text = cleanUserText(text);
    if (!text) return null;
    if (/^<(ide_|command-|local-command-)/.test(text)) return null;
    return { uuid: obj.uuid, role: "user", text, timestamp: obj.timestamp };
  }

  if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
    const text = obj.message.content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text).join("\n").trim();
    if (!text) return null;
    return { uuid: obj.uuid, role: "assistant", text, timestamp: obj.timestamp };
  }

  return null;
}

async function loadFile(path: string): Promise<Msg[]> {
  const buf = await Bun.file(path).arrayBuffer();
  const text = dec.decode(buf);
  const seen = new Set<string>();
  const out: Msg[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const m = parseLine(line);
    if (m && !seen.has(m.uuid)) { seen.add(m.uuid); out.push(m); }
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
      const m = parseLine(line);
      if (m && m.role === "user") return m.text.slice(0, 240);
    }
  } catch {}
  return "";
}

const previewCache = new Map<string, { mtime: number; preview: string }>();
let snapshot: SessionMeta[] = [];
let snapshotHash = "";

async function refreshSessions(): Promise<{ list: SessionMeta[]; changed: boolean }> {
  let projects: string[];
  try { projects = await readdir(PROJECTS_DIR); } catch { return { list: [], changed: false }; }
  const list: SessionMeta[] = [];
  for (const proj of projects) {
    const dir = join(PROJECTS_DIR, proj);
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(dir, f);
      let s;
      try { s = await stat(full); } catch { continue; }
      const cached = previewCache.get(full);
      let preview: string;
      if (cached && cached.mtime === s.mtimeMs) {
        preview = cached.preview;
      } else {
        preview = await readPreview(full);
        previewCache.set(full, { mtime: s.mtimeMs, preview });
      }
      list.push({ path: full, project: proj, mtime: s.mtimeMs, preview });
    }
  }
  list.sort((a, b) => b.mtime - a.mtime);
  const hash = list.map(s => `${s.path}:${s.mtime}`).join("|");
  const changed = hash !== snapshotHash;
  snapshotHash = hash;
  snapshot = list;
  return { list, changed };
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
    const m = parseLine(line);
    if (m && !sub.seen.has(m.uuid)) {
      sub.seen.add(m.uuid);
      send(sub.controller, "append", m);
    }
  }
}

async function tick() {
  const { list, changed } = await refreshSessions();
  const latest = list[0]?.path ?? null;
  if (changed) for (const sub of subs) send(sub.controller, "sessions", list);
  for (const sub of subs) {
    try { await processSub(sub, latest); }
    catch (err) { console.error("sub error:", err); }
  }
}

setInterval(() => { tick().catch(err => console.error("tick:", err)); }, POLL_MS);
tick().catch(err => console.error("init:", err));

const html = await Bun.file(new URL("./index.html", import.meta.url)).text();

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/sessions") {
      return Response.json(snapshot);
    }

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 60)));
      return search(q, limit).then(hits => Response.json(hits));
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
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`claude-rtl-viewer → http://localhost:${PORT}`);
console.log(`watching: ${PROJECTS_DIR}`);
