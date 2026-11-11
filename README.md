# Ajaia Docs

A lightweight collaborative document editor inspired by Google Docs. Create, format, import and share documents, with owner / editor / viewer access.

- **Live demo:** `PASTE_YOUR_DEPLOYED_URL_HERE`
- **Stack:** Node.js 22 (built-in `http`, `node:sqlite`, `node:test`) + vanilla JS front end. **Zero npm dependencies**, no build step.

## Demo accounts

All accounts use the password **`demo1234`**. The login page also has one-click buttons for each of them.

| User | Email | Seeded state |
|---|---|---|
| Lena Fischer | `lena@ajaia.dev` | Owns "Welcome to Ajaia Docs" |
| Ravi Menon | `ravi@ajaia.dev` | Has **editor** access to Lena's welcome doc |
| Grace Holt | `grace@ajaia.dev` | Nothing shared yet (good for testing a fresh share) |

### Two-minute reviewer path

1. Sign in as **Lena**. Create a blank document, rename it, then use headings, **bold**, *italic*, underline and lists. The status next to the title changes to "All changes saved".
2. Refresh the page. The content and formatting are still there.
3. Click **Share**, choose **Grace**, and set **Can view**.
4. Click **Switch user** and sign in as **Grace**. The document appears under **Shared with me**. When she opens it, it is read-only and shows a banner saying so.
5. Back as Lena, click **Import a file** (or drag a file onto the dashboard) and pick one from [`samples/`](samples/).
6. Open any document you've edited and click **History**. Pick an earlier version to preview it, then click **Restore this version**. Your text from before the restore is kept in the history, so the restore can be undone.
7. Optional conflict demo: open the welcome doc as Lena in one browser and as Ravi in a private window. Edit in both. The second save is rejected with a conflict banner instead of silently overwriting the first.

## Features

| Area | What works |
|---|---|
| Documents | Create, rename (inline title), edit, autosave after 0.7 s idle (Ctrl/Cmd+S forces a save), reopen, delete (owner only) |
| Rich text | Headings H1 to H3, bold, italic, underline, strikethrough, bulleted and numbered lists, quote, code block, clear formatting, undo/redo, toolbar active states, word count |
| File upload | **Import a file** creates a new document from `.txt`, `.md` / `.markdown` or `.docx` (max 2 MB). **Insert from file** puts a file's content at the cursor in an open document. Drag and drop works on the dashboard. Other file types are rejected with a clear message. |
| Sharing | The owner grants **Can edit** or **Can view** access, changes roles and revokes access. Collaborators can leave a document. The dashboard separates **My documents** from **Shared with me** and shows share counts and role badges. |
| Persistence | SQLite: documents, shares, users and sessions. Formatting is stored as sanitized semantic HTML. |
| Version history | Snapshots are taken automatically as you edit (at most every 5 minutes, plus whenever a different person starts editing), each credited to whoever wrote that content. The **History** panel lists versions with time and author and shows a preview. **Restore** brings an old version back and first snapshots the current text, so a restore can be undone. Anyone with access can view history; only owners and editors can restore. |
| Concurrency | Optimistic versioning. A stale save returns `409` and the UI offers "Load their version" or "Keep mine". Open documents poll every 8 s and pick up collaborators' saves. |
| Safety | Server-side allowlist HTML sanitizer (no attributes survive), strict CSP, HttpOnly session cookies, scrypt password hashes, input validation with clear 4xx errors, and 404s (not 403s) for documents you can't access so ids don't leak |

### Supported import formats

| Format | Mapping |
|---|---|
| `.txt` | Blank lines become paragraphs; single newlines become line breaks |
| `.md` | Headings, bold, italic, strikethrough, inline and fenced code, quotes, flat lists, rules. Links become "text (url)". Images are dropped. |
| `.docx` | Title / Heading 1 to 3 styles, bold, italic, underline, strikethrough, bulleted vs numbered lists (read from `numbering.xml`). Images, tables (their text is kept), comments and fonts are dropped. |

Legacy `.doc`, `.pdf`, `.rtf` and `.odt` are **not supported**. The import button in the UI says so.

## Run locally

Requirements: **Node.js 22.13 or newer** (for the built-in `node:sqlite`). Nothing else is needed.

```bash
cd ajaia-docs
npm start            # http://localhost:3000  (no npm install needed: zero dependencies)
npm run dev          # same, restarts on file changes
npm test             # 22 automated tests
```

The database is created at `./data/ajaia.db` on first run and seeded with the demo users. Delete that file to reset.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/ajaia.db` | SQLite file location (point it at a mounted volume in production) |

## Tests

`npm test` runs `node:test` across four files:

- **`tests/api.test.js`** runs integration tests against a real server and a temporary database. They cover auth, the full create → edit → share as viewer (write blocked with 403) → upgrade to editor → revoke flow, non-owners being unable to delete or reshare, `409` on stale saves, validation errors and `.docx` upload. They also cover version history: snapshots are throttled, viewers can view history but not restore, a version can't be read through another document's URL, and a restore keeps the previous text in history.
- **`tests/importers.test.js`** covers Markdown, text and `.docx` conversion, plus rejection of unsupported, empty, oversized and corrupt files.
- **`tests/sanitize.test.js`** covers XSS vectors (scripts, event handlers, `javascript:` links, a quoted `>` inside attributes), tag balancing, normalizing Chrome's `contenteditable` output, and snippet text that must not be double-decoded.
- **`tests/auth.test.js`** covers password hashing (salted, verifiable, rejects wrong passwords) and cookie parsing, including a malformed cookie that previously crashed every request.

## Deployment

The repo includes a [`render.yaml`](render.yaml) blueprint. To deploy:

1. Push this folder to a GitHub repo.
2. In Render, choose **New → Blueprint** and select the repo. Alternatively, create a **Web Service** with build `npm install`, start `npm start` and env `NODE_VERSION=22`.
3. Open the generated `onrender.com` URL.

> **Persistence caveat on free hosting:** Render's free web services have an ephemeral filesystem and spin down after 15 idle minutes, so the SQLite file is reset on restart, redeploy or spin-down. Data persists across page refreshes and within a review session, and the demo users and welcome doc are re-seeded on every boot. For durable storage, run the app on any host with a persistent volume and set `DB_PATH` to a path on that volume. No code changes are needed.

The first request after a spin-down takes about a minute while Render wakes the service.

## Project structure

```
server/
  index.js            entry point (PORT, graceful shutdown)
  app.js              HTTP server, router, auth middleware, document/share/import endpoints, static files
  db.js               schema (users, sessions, documents, shares, versions) + seed data (node:sqlite)
  auth.js             scrypt hashing, sessions, cookies
  sanitize.js         allowlist HTML sanitizer + text snippets
  importers/          txt / markdown / docx -> HTML (docx via a minimal ZIP reader in zip.js)
public/
  index.html, styles.css
  app.js              SPA: login, dashboard, editor (contenteditable), share and history dialogs
  clean-html.js       client-side paste cleanup that mirrors the server allowlist
tests/                node:test suites + fixtures
samples/              example .md / .txt / .docx files to try the import flow
screenshots/          UI screenshots from the automated browser run
```

## API summary

All endpoints are under `/api`, use JSON and authenticate with an HttpOnly `sid` cookie.

| Method & path | Who | Notes |
|---|---|---|
| `POST /login`, `POST /logout`, `GET /me` | anyone | `/me` returns `{ user: null }` when signed out |
| `GET /documents` | user | `{ owned: [...], shared: [...] }` |
| `POST /documents` | user | `{ title?, content? }` |
| `GET /documents/:id` | any role | includes `role`, `owner`, `shares`, `version` |
| `PATCH /documents/:id` | owner, editor | `{ title?, content?, version }`. Returns `409` and the current doc if `version` is stale. |
| `DELETE /documents/:id` | owner | |
| `POST /documents/:id/shares` | owner | `{ email, role: "editor" \| "viewer" }`. An existing share is updated. |
| `DELETE /documents/:id/shares/:userId` | owner, or the user themself | revoke / leave |
| `GET /documents/:id/versions` | any role | list of versions (no content), newest first |
| `GET /documents/:id/versions/:versionId` | any role | one version with its content, for the preview |
| `POST /documents/:id/versions/:versionId/restore` | owner, editor | snapshots the current text, then restores the version. Returns the updated doc. |
| `POST /import` | user | raw file body + `X-Filename` header. Creates a document. |
| `POST /documents/:id/import` | owner, editor | returns converted `{ html }` for insertion at the cursor |

## Status: what's done, what's not, what's next

**Working end to end:** everything in the Features table above, covered by the automated tests and an automated Playwright run through the full flow (see `screenshots/`).

**Intentionally out of scope:** real-time co-editing (cursors, CRDT/OT), comments and suggestions, images and tables in the editor, public link sharing, real sign-up and password reset, and nested lists from `.docx` (they are flattened).

**Next 2 to 4 hours, in priority order:**

1. Durable hosted storage: move to hosted Postgres, or a host with a persistent volume, so the live demo keeps data across restarts.
2. Version history improvements: highlight what changed between two versions (a diff view), and let users name important versions.
3. Replace `document.execCommand` (deprecated, but still universally supported) with a structured editor library that keeps documents in a defined format, and build real-time collaboration on top of it over WebSockets.
4. Export to `.md` / `.docx`, and a "share by link" option.