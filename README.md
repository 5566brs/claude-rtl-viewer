<div dir="rtl">

# claude-rtl-viewer

צפייה מקומית בתמלילי שיחות של Claude Code (קבצי `.jsonl`) עם תמיכה נכונה ב-RTL —
טקסט עברי ואנגלי באותה הודעה כל אחד נשמר בכיוונו. קורא מ-`~/.claude/projects`
ומשדר את העדכונים בזמן אמת.

## מה זה הדבר הזה?

- **מעקב חי** אחרי שיחות צ'ט עם קלוד קוד. שיחות מתעדכנות ככל ש-Claude כותב
  לדיסק; השיחה החדשה ביותר במעקב אוטומטי, וניתן גם להצמיד שיחה ספציפית.
- **תצוגה מפורטת של קריאות לכלים.** כל קריאה לכלי מופיעה בתקציר בין הודעות —
  לחיצה פותחת פירוט מלא. תצוגה מפורטת מותאמת עבור:
  - `Edit` — **diff git, צד-מול-צד** (ישן | חדש).
  - `Write` — נתיב הקובץ + תצוגת תוכן.
  - `Read` — נתיב + טווח שורות / טווח עמודים.
  - `Bash` — פקודה + תיאור + דגלים (timeout, background).
  - `TodoWrite` — רשימת משימות עם סימני `[ ]` / `[~]` / `[x]` לפי סטטוס.
  - `Grep`, `Glob`, `Task`, `WebFetch`, `WebSearch`, `NotebookEdit`, `Skill` —
    סיכום key/value או תוכן ה-prompt לפי העניין.
  - כל השאר מציג JSON מעוצב כברירת מחדל.
  - כפתור `{ }` בכל פריט מחליף בין התצוגה המעובדת ל-JSON גולמי.
- **תצוגת עץ לפי פרויקטים.** סרגל הצד מקבץ את השיחות לפי תיקיית הפרויקט שלהן.
  כל קבוצה נפתחת ונסגרת בנפרד, וכפתור "כווץ הכל" סוגר את כולן בלחיצה אחת. ניתן
  לבטל את הקיבוץ ולקבל רשימה שטוחה ממוינת לפי זמן.
- **חיפוש חוצה-פרויקטים.** חיפוש AND של מילים בכל שיחה ב-`~/.claude/projects`,
  ממוין לפי סך המופעים עם מועד אחרון כשובר שוויון. לחיצה על תוצאה קופצת להודעה
  המדויקת עם הבהוב להדגשה.
- **ייצוא.** כפתור `JSON` מוריד את הודעות השיחה הפעילה כקובץ JSON. כפתור `HTML`
  נכנס למצב בחירה — צ׳ק-בוקס בכל הודעה, עם "בחר הכל" / "בטל הכל" / "בטל" — והפלט
  הוא קובץ HTML עצמאי עם CSS מוטמע, ללא סרגל צד, ללא JS, ברוחב מלא. בהדפסה
  מוסתרים כל הכפתורים והסרגל ונשאר רק תוכן השיחה.
- **שני מקורות נתונים.** שרת [Bun](https://bun.sh/) מקומי שמשדר ב-SSE, או מצב
  דפדפן-בלבד בעזרת File System Access API + `FileSystemObserver` (דפדפנים
  מבוססי Chromium — Chrome / Edge).

## הפעלה

הדרך הקלה (מומלץ): השתמש בגרסה המתארחת בכתובת
<https://claude-rtl-viewer.pages.dev>. זהו דף סטטי שרץ כולו בדפדפן (מצב File
System Access API) ואינו דורש התקנה.

## דרישות לריצה עצמאית

- [Bun](https://bun.sh/) 1.0 ומעלה.

### הרצה עצמאית

```bash
git clone https://github.com/5566brs/claude-rtl-viewer.git
cd claude-rtl-viewer
bun run start    # מאזין על $PORT, ברירת מחדל 5577
bun run dev      # אותו דבר עם hot reload דרך `bun --watch`
```

ואז פתח <http://localhost:5577>.

ספריית התמלילים היא `~/.claude/projects` כברירת מחדל (נגזרת מספריית הבית של
משתמש מערכת ההפעלה הנוכחי). ניתן לעקוף עם משתנה הסביבה `CLAUDE_PROJECTS_DIR` אם
שלך נמצאת במקום אחר — זה כלי מקומי חד-משתמשי, ובכוונה ללא שכבת קונפיגורציה
עמוקה יותר.

## פרטיות

הפרויקט פועל מקומית בלבד — אין שליחת מידע מהתמלילים לשום שרת חיצוני, אין מעקב
(analytics), ואין פרסומות. גם הגרסה המתארחת היא דף סטטי שמשתמש ב-File System
Access API בדפדפן, כך שהקבצים נשארים אצלך במחשב.

## רישיון

MIT — ראה [LICENSE](LICENSE).

</div>

---

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
- **Project tree.** The sidebar groups sessions by their project folder. Each
  group expands or collapses independently, and a "Collapse all" button wipes
  them in one click. Grouping can be turned off for a flat, time-sorted list.
- **Cross-project search.** AND-of-words across every session in
  `~/.claude/projects`, ranked by total occurrences with recency as the
  tiebreaker. Clicking a hit jumps to the exact message with a flash highlight.
- **Export.** A `JSON` button downloads the active session's parsed messages
  as a JSON file. An `HTML` button enters a selection mode — checkbox per
  message, with select-all / deselect-all / cancel — and produces a standalone
  HTML file with embedded CSS, no sidebar, no JS, full-width. Printing strips
  all buttons and the sidebar and leaves just the conversation.
- **Two data sources.** A local [Bun](https://bun.sh/) server that streams via
  SSE, or a browser-only mode using the File System Access API +
  `FileSystemObserver` (Chromium-based browsers — Chrome / Edge).

## Run

The easy way (recommended): use the hosted version at
<https://claude-rtl-viewer.pages.dev>. It's a static page that runs entirely in
the browser (File System Access API mode) and requires no installation.

## Requirements for local running

- [Bun](https://bun.sh/) 1.0 or later.

### Run it yourself

```bash
git clone https://github.com/5566brs/claude-rtl-viewer.git
cd claude-rtl-viewer
bun run start    # serves on $PORT, defaulting to 5577
bun run dev      # same, with hot reload via `bun --watch`
```

Then open <http://localhost:5577>.

The transcripts directory defaults to `~/.claude/projects` (resolved from the
current OS user's home). Override with the `CLAUDE_PROJECTS_DIR` env var if
yours lives elsewhere — this is a single-user local tool, deliberately without
a deeper config layer.

## Privacy

The project runs locally only — no transcript data is sent to any external
server, no analytics, no ads. The hosted version is also a static page that
uses the browser's File System Access API, so your files stay on your machine.

## License

MIT — see [LICENSE](LICENSE).
