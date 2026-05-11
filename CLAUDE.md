# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun run start` — run the server once (`server.ts` on port `PORT` or `5577`).
- `bun run dev` — run with `bun --watch`. **Important caveat:** Bun's `--watch` only restarts when files in the import graph change. `index.html` is loaded via `Bun.file(...).text()` per request, not imported, so edits to it are picked up by a browser refresh, not a server restart. Edits to `server.ts` do trigger a restart.
- No build, lint, or test setup. There is no `tsconfig.json`; Bun runs the TypeScript directly. The IDE will show many "Cannot find name 'Bun'/'process'/'node:fs'" diagnostics — that's expected without `@types/node` / `@types/bun` installed; runtime is fine.

The server resolves the transcripts directory as `process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects")` (see [server.ts:6](server.ts#L6)). The env var is the escape hatch; otherwise it follows the current OS user's home — no per-machine edits needed. This is still a single-user local tool.

## Architecture

Two-file app with two interchangeable data sources:

- [server.ts](server.ts) — Bun HTTP server. Watches `.claude/projects` via `fs.watch({ recursive: true })` and streams events over SSE. Serves the HTML and a small REST surface.
- [index.html](index.html) — single-page client (plain JS + `marked` from CDN, no bundler). The script is structured around a `Source` abstraction with **two implementations** that emit the same events:
  - `ServerSource` — wraps `EventSource` + `fetch` against the Bun server (default).
  - `LocalSource` — uses **File System Access API** (`showDirectoryPicker`) plus **`FileSystemObserver`** to read and watch the directory directly inside the browser, with **no server**. The directory handle is persisted in IndexedDB so a returning user only re-grants permission, not re-picks the folder.

A small UI in the sidebar lets the user pick which source to run. Mode preference is stored in `localStorage` under `rtl-viewer:source`. The intent is that the same `index.html` can be hosted on an HTTPS domain: from there it can either talk to a localhost Bun server (CORS + Private Network Access headers are wired for this) or run fully in-browser via the FS Observer.

### Server pipeline (push model, not polling)

The server is **event-driven**: there is no `setInterval` ticking the filesystem. Sequence:

1. `initialScan()` walks every project subfolder once at startup and seeds the `snapshot: SessionMeta[]` plus `previewCache`.
2. `fs.watch(PROJECTS_DIR, { recursive: true }, ...)` fires on any file change inside the tree. `relativePathComponents`-style `filename` is normalized; non-`.jsonl` events are ignored.
3. Each event is **debounced per-path** with a `DEBOUNCE_MS = 30` window via `pendingChanges: Map<path, Timeout>` — Windows fires the same write twice, so coalescing is required.
4. `handleChange(relPath)` calls `syncFile()` (which re-stats and updates the entry's `mtime` / `preview`, or removes it if the file disappeared), then for each affected SSE subscriber calls `processSub()`:
   - If the file's `size` grew, only the new byte range is read via `Bun.file(path).slice(lastSize, size)` and parsed line by line, emitting `append` events.
   - If it shrank, send a full `reset`.
   - If the *latest* session changed (e.g. a brand-new session file appeared), every "latest"-mode sub gets a `reset` to the new target.
5. A per-sub `Set<string>` of seen UUIDs prevents duplicate emits when a tail slice straddles a previously-seen line.

`messageCache` keyed by `path + mtime` lets `/api/search` reuse already-parsed sessions across queries.

### `.jsonl` parsing rules

`parseLine` is the single source of truth for what shows up in the UI. **It exists in two places that must stay in sync**: the server's [server.ts](server.ts) (canonical) and a JS port inside [index.html](index.html) used by `LocalSource` when there's no server. If you change the rules — add a new tag to strip, surface a new event kind — you must update **both** copies.

The rules:

- Skips `obj.isSidechain` entries (sub-agent traffic).
- For `type === "user"`: accepts string or array `content`, joins `text` parts, then strips `<system-reminder>`, `<command-…>`, `<local-command-…>`, `<user-prompt-submit-hook>`, `<ide_…>` blocks via `AUTO_BLOCK_PATTERNS`. If what remains is empty or starts with one of those tags, the message is dropped entirely.
- For `type === "assistant"`: keeps only `text` parts (tool calls/results are ignored on purpose).

### HTTP surface

All responses include `Access-Control-Allow-Origin: *` plus `Access-Control-Allow-Private-Network: true` so an HTTPS-hosted page can call `http://localhost:5577` from a browser. `OPTIONS` returns 204 with the same headers.

- `GET /` and `GET /index.html` → reads `index.html` from disk on each request (so a browser refresh picks up edits without restarting the server).
- `GET /api/sessions` → snapshot JSON; mainly for debugging — the client normally gets sessions over SSE.
- `GET /api/search?q=&limit=` → AND-of-terms search across `messageCache`. Score = total term occurrences; ties break by `timestamp` desc. `limit` defaults to 60, hard max 200.
- `GET /events` (with optional `?file=`) → SSE stream emitting `ready`, `sessions`, `reset`, `append`. `idleTimeout: 0` keeps long connections alive.

### LocalSource (in-browser source) ([index.html](index.html))

`LocalSource` mirrors the server's behavior using browser-only APIs. Touching one side usually means touching the other.

- Initial scan: `for await (const [name, handle] of dirHandle.entries())` over project subfolders, then over `*.jsonl` files inside each. Path keys are `${projectName}/${fileName}` — these stand in for the server's full filesystem paths everywhere in the client (`activeFile`, sidebar lookups, search hits all use this format in local mode).
- Change detection: `new FileSystemObserver(...)` with `observe(handle, { recursive: true })`. Records have `type: "appeared" | "disappeared" | "modified" | "moved"`, `changedHandle`, and `relativePathComponents`. The observer fires no records for files that exist when `observe()` is called — that's why an explicit initial scan is required.
- Burst coalescing: like the server side, `_onRecords` stages dirty paths in a `Map` and a 30 ms `setTimeout` triggers a single `_flush()` that does the per-file work in one pass. Without this, rapid writes create N redundant `getFile()` reads.
- Tail-read: `await handle.getFile()` returns a fresh `File` whose `.size` and `.lastModified` are point-in-time. `file.slice(lastSize, size).text()` is the browser equivalent of `Bun.file().slice()`. Same shrink-means-reset rule as the server.
- The directory handle is saved in IndexedDB (`rtl-viewer` DB → `kv` store → key `rtl-viewer:dir`). On reload, `tryRehydrateLocal()` checks `queryPermission({ mode: "read" })`; if `granted`, it goes straight in. If `prompt`, the user has to click "בחר תיקייה" again because re-granting requires a user gesture.
- The `Source` abstraction means the rest of the app (`pinTo`, `followLatest`, search rendering, sidebar paint) doesn't know which source it's talking to. Don't reach around it from UI code.

### Client conventions

- RTL/LTR is handled with `dir="auto"` plus `unicode-bidi: plaintext` on block elements so Hebrew and English in the same message each pick their own direction. Code blocks are forced LTR. Don't replace this with a global `dir="rtl"`.
- Markdown is rendered with `marked`, but raw HTML tokens are escaped via a `walkTokens` hook — preserve this when touching the renderer; it's the only XSS guard. **Do not switch to overriding `renderer.html`**: in `marked@12` that callback receives a token without a populated `text` field and returns `undefined`, which silently replaces user messages with the literal string "undefined". A user message containing `<style>` or an unclosed tag rendered through unescaped `innerHTML` will wipe the whole SPA — including the sidebar — so the user can't even click away. The `try/catch` around `marked.parse` that falls back to `<pre>` is also part of this guard.
- Auto-scroll only sticks to the bottom when `nearBottom()` is true at the moment an `append` arrives — so a user reading scrollback isn't yanked down.
- Search-result clicks set `pendingScrollUuid`; the next `reset` looks up the matching `[data-uuid]` and scrolls it into view with a `.flash` highlight. The flash is the visual anchor for "you landed here" — keep it. If the user is already on the target session, the scroll happens immediately without re-pinning. `Esc` in the search box clears and returns to the session list.

## Design intent (don't lose these on refactors)

- **Disk-only by design.** The viewer reads `.jsonl` files after Claude Code flushes content blocks; it cannot show token-by-token streaming and that is intentional. Don't try to parse partial JSON to fake live thinking — if a "currently writing" hint is needed, drive it from file `mtime` movement, not partial content. True streaming would require the Claude Agent SDK or a VS Code extension host, which is out of scope for this tool.
- **Search is AND-of-words, ranked by total occurrences.** Every whitespace-separated term must appear in a message; score is total match count across terms; ties break by `timestamp` desc. This is a deliberate choice over OR/fuzzy/embedding search.
- **Styling is a placeholder pending the official Claude Code VS Code extension CSS.** The intent is for this UI to mirror that panel with RTL added on top. Don't invent a new palette or add a dark-mode toggle on your own — ask for a screenshot or the extension's CSS first.
- **Single-user local tool.** No multi-user, no auth, no shared deployment. `PROJECTS_DIR` is derived from `homedir()` with a `CLAUDE_PROJECTS_DIR` env var override — don't add more config layers on top. Hosting `index.html` on an HTTPS domain is in scope (so the page can run anywhere and either reach a localhost server or use the in-browser FS source) — but the *server* still expects to run on the user's own machine against their own `.claude/projects`.
- **Chrome/Edge are the target browsers.** `LocalSource` depends on File System Access API and `FileSystemObserver`, neither of which is in Firefox or Safari. That's accepted — `ServerSource` works everywhere and is the universal fallback.

## Working with this repo

- When fixing a bug on previously-uncommitted code, the user prefers two commits: first the original (working or not) so it's in history, then the fix as a separate commit. Don't squash them.
