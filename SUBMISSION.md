# Submission: Ajaia Docs (AI-Native Full Stack Developer Assignment)

## Links

- **Live product:** https://ajaia-docs-cpov.onrender.com/ (the first load after idle can take about a minute while the free instance wakes up)
- **Walkthrough video:** see [`VIDEO_URL.txt`](VIDEO_URL.txt)

## Test accounts (password for all: `demo1234`)

| Email | Use it to |
|---|---|
| `lena@ajaia.dev` | Owner flows: create, import, share, revoke, delete |
| `ravi@ajaia.dev` | Already an **editor** on Lena's "Welcome to Ajaia Docs" |
| `grace@ajaia.dev` | Fresh account for testing a new share (try viewer access) |

The login page has one-click buttons for each account. Use **Switch user** in the top right to change accounts.

## What's included

| Path | Contents |
|---|---|
| `server/`, `public/` | Full source code (Node 22, zero npm dependencies) |
| `tests/` | 19 automated tests (`npm test`): API/sharing integration, importers, sanitizer |
| `README.md` | Features, local setup and run, tests, deployment, API, status and next steps |
| `ARCHITECTURE.md` | Architecture note: what was prioritized and why, trade-offs, cuts |
| `AI_WORKFLOW.md` | AI tools used, where they helped, what was changed or rejected, how it was verified |
| `SUBMISSION.md` | This file |
| `VIDEO_URL.txt` | Walkthrough video link |
| `screenshots/` | Login, editor formatting, share dialog, owner dashboard, shared-with-me dashboard, viewer read-only, edit conflict |
| `samples/` | `Product Brief.md`, `Standup Notes.txt`, `Meeting Notes.docx` for trying the import flow |
| `render.yaml` | One-click Render blueprint |

## Status

**Working end to end:** create, rename, edit, autosave and reopen documents. Rich text (H1 to H3, bold, italic, underline, strikethrough, bulleted and numbered lists, quote, code). Import of `.txt`, `.md` and `.docx` as a new document or into an existing one. Owner / editor / viewer sharing, with a "My documents" vs "Shared with me" split. SQLite persistence. Conflict detection on concurrent edits. Validation and error handling.

**Incomplete / out of scope:** real-time co-editing, comments, version history UI, images and tables, link sharing, signup. On free Render hosting, data resets when the instance restarts or sleeps; demo data is re-seeded automatically.

**Next 2 to 4 hours:** durable hosted storage, version history with restore, a structured editor library as the base for real-time collaboration (Yjs), and export to `.md` / `.docx`.
