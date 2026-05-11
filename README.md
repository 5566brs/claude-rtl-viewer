# claude-rtl-viewer

A local viewer for Claude Code transcripts (`.jsonl`) with proper RTL support —
Hebrew and English in the same message each render in their own direction. Reads
from `~/.claude/projects` and tails it live.

## What it does

- **Live tail** of `~/.claude/projects`. Sessions update as Claude writes to disk;
  the newest session is followed automatically, or you can pin a specific one.
- **Tool-call detail view.** Each tool call surfaces as a thin bar between
  messages — click to expand. Supported with custom rendering:
  - `Edit` — git-style **side-by-side diff** (old | new), with a hatched
    background for empty placeholder cells. Collapses to a unified single
    column under 700px.
  - `Write` — file path + content preview.
  - `Read` — path + line range / page range.
  - `Bash` — command + description + flags (timeout, background).
  - `TodoWrite` — checklist with `[ ]` / `[~]` / `[x]` markers per status.
  - `Grep`, `Glob`, `Task`, `WebFetch`, `WebSearch`, `NotebookEdit`, `Skill` —
    key/value summary or prompt body as appropriate.
  - Anything else falls back to a pretty-printed JSON dump.
  - A `{ }` button on each entry swaps the rendered view for the raw JSON.
- **Cross-project search.** AND-of-words across every session in
  `~/.claude/projects`, ranked by total occurrences with recency as the
  tiebreaker. Clicking a hit jumps to the exact message with a flash highlight.
- **Two data sources.** A local [Bun](https://bun.sh/) server that streams via
  SSE, or a browser-only mode using the File System Access API +
  `FileSystemObserver` (Chromium-based browsers — Chrome / Edge).

## Requirements

- [Bun](https://bun.sh/) 1.0 or later.

## Run

```bash
bun run start    # serves on $PORT, defaulting to 5577
bun run dev      # same, with hot reload via `bun --watch`
```

Then open <http://localhost:5577>.

The transcripts directory defaults to `~/.claude/projects` (resolved from the
current OS user's home). Override with the `CLAUDE_PROJECTS_DIR` env var if
yours lives elsewhere — this is a single-user local tool, deliberately without
a deeper config layer.

## License

MIT — see [LICENSE](LICENSE).
