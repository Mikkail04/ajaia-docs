# Architecture note

## Shape of the system

```
Browser (vanilla JS SPA)                     Node 22 server (no dependencies)
┌──────────────────────────────┐   JSON    ┌─────────────────────────────────────┐
│ login / dashboard / editor   │ ───────▶  │ router + session cookie auth        │
│ contenteditable + toolbar    │  cookie   │ access check (owner/editor/viewer)  │
│ autosave (debounce, versioned│ ◀───────  │ sanitizeHtml() on every write       │
│ PATCH) + 8s poll             │           │ importers: txt / md / docx → HTML   │
│ share dialog, import, paste  │           │ node:sqlite (single file)           │
└──────────────────────────────┘           └─────────────────────────────────────┘
```

**Data model (SQLite):** `users`, `sessions`, `documents(id, owner_id, title, content_html, version, updated_by, timestamps)` and `document_shares(document_id, user_id, role ∈ {editor, viewer})`. Ownership is a column on the document rather than a share row. That way a document can never end up with zero owners, and "owned vs shared" is a simple query split.

## What I prioritized and why

1. **A coherent core loop over feature breadth.** The goal was create → format → autosave → reopen → share → see it from the other account. Every part of that loop has an automated test and was exercised and tested in a real browser.
2. **Sharing rules that hold up.** Roles are checked on the server for every request, not just hidden in the UI. Viewers get a read-only editor *and* a `403` if they try to write anyway. Users with no access get `404`, so document ids can't be probed. Only owners can share, revoke or delete. Collaborators can leave.
3. **Protecting work from being overwritten.** Autosave is debounced and saves are sent one at a time (never two overlapping requests). Every save carries the version it was based on. If someone else saved first, the server returns `409` with their copy, and the user chooses to load it or overwrite it. That replaces silent last-write-wins. Offline or 5xx saves retry, and leaving the page flushes a pending save with `keepalive`.
4. **Safe storage of rich text.** Documents are stored as HTML because that is what the editor produces and what renders without a conversion layer. That only works if the HTML is trusted. Every write and every import goes through an allowlist sanitizer that keeps 16 semantic tags and **zero attributes**, re-escapes text and re-balances tags. A strict CSP is a second layer of defence.
5. **Zero-dependency, zero-build deploy.** `node:sqlite`, `node:http` and `node:test` cover what this scope needs. There is no `node_modules`, no bundler and no native build step, so `npm start` works anywhere Node 22 runs. Reviewers can run it in seconds. *(Honest context: the environment I built this in couldn't install packages, which pushed me this way, but I'd defend the choice for a 4–6 hour prototype anyway.)*

## Key decisions and trade-offs

| Decision | Why | Cost / what I'd change |
|---|---|---|
| `contenteditable` + `document.execCommand` | Native undo/redo, IME, spellcheck and shortcuts, with no library | `execCommand` is deprecated (but still supported in every browser) and produces messy markup. I normalize it in the sanitizer (`b→strong`, `div→p`, lists nested in `<p>` get un-nested). The next step would be a structured editor library that enforces a document schema. |
| HTML as storage format | Matches the editor, renders directly, readable in the DB | Not great for diffing or merging. A JSON document model (ProseMirror) would be better for history and real-time collaboration. |
| Optimistic concurrency + polling instead of real-time | Gives correctness for concurrent edits at a fraction of the complexity | Two people can't type in the same doc at once; the second sees a conflict. Real-time would use Yjs + WebSockets. |
| Seeded users + real login (scrypt, HttpOnly cookie sessions) | Reviewers can test sharing with no signup flow, and the auth path is still real | No signup, password reset or OAuth |
| Import produces HTML that goes through the *same* sanitizer | One trust boundary for all content | The `.docx` support is a deliberate subset (styles, runs, lists). Images and tables are dropped. |
| Raw-body upload with an `X-Filename` header | No multipart parser needed. The custom header also forces a CORS preflight for cross-site requests. | One file per request (fine for this UX) |
| SQLite file | Zero setup, transactional, enough for this scale | Free hosting with an ephemeral disk resets it. Set `DB_PATH` to a persistent volume, or swap the queries in `app.js` to Postgres. |

## Deliberately deprioritized

Real-time cursors, comments, version history UI, images and tables, link sharing, account management, mobile-optimized editing beyond a responsive layout, nested lists, and export. Each one would have been shallow in the timebox. I chose to make the core loop solid and well tested instead.
