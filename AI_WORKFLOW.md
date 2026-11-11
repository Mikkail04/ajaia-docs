# AI-native workflow note

> **Before submitting:** this note was drafted from the actual build session. Edit it so it is accurate in your own words, and fill in the sections marked ✏️ with what *you* did. Reviewers will ask about it in the video and any follow-up.

## Tools used

- **Claude (Anthropic, Claude Opus 5.5 in the Claude app's agentic workspace)** was the primary pair programmer. It scaffolded the first draft of the server, front end, tests and docs. It ran the test suite and a scripted headless-browser (Playwright) run of the full user flow inside its own sandbox.

## Where AI materially sped things up

- **Boilerplate-heavy, well-specified pieces:** the router, the SQLite schema and queries, the share dialog, and CSS. These would have taken hours by hand and were produced in a much more timely manner.
- **Format-parsing code I'd otherwise have pulled a library in for:** a minimal ZIP reader plus a `.docx` → HTML mapper (paragraph styles, run formatting, and `numbering.xml` to tell bulleted from numbered lists), plus a small Markdown converter.
- **Test scaffolding:** the integration tests that drive multiple through share, viewer-blocked, editor-allowed and revoke flows against a real server and a temporary database.
- **Exercising the UI automatically:** a Playwright script that logs in, formats text, reloads, shares, switches user, imports files and forces an edit conflict. It produced the screenshots in `screenshots/`.

## AI output that was changed or rejected

These came up during the build session:

- **Skipped a heavy editor library.** The environment I built in couldn't install packages, and for a short prototype a full editor framework would have been more than I needed anyway. I used the browser's built-in editing (`contenteditable`) with strict cleaning of the HTML on the server, so the app has no dependencies and runs without an install step.
- **Sanitizer bug caught by the browser run, not by unit tests.** The first sanitizer passed its unit tests. The real-browser run then showed that Chrome's `contenteditable` produces `<p><ul>…</ul></p>` (invalid nesting) when you start a list from an empty paragraph, and that was being stored as-is. The fix closes an open `<p>` before any block element (as the HTML parser does) and drops empty paragraphs. A regression test now covers it.
- **`/api/me` returned 401 when signed out.** That is technically fine but put a red console error on every first visit. It now returns `{ user: null }`.
- **Sticky toolbar overlapped the header when scrolling.** Spotted in the screenshots. The header and toolbar were restructured into one sticky bar.
- **Test script didn't run on Node 22** (`node --test tests/` treats a directory argument as a file). Switched to a glob.
- **Persistence claims checked against Render's docs** before writing the README. Free web services have an ephemeral filesystem, so the README states the reset caveat instead of implying durable storage.
- **Found a bug while tidying `auth.js`.** A malformed cookie caused every API request to fail with a server error. Now bad cookies are skipped, and a test covers it.

## How correctness, UX and reliability were verified

- - **22 automated tests** (`npm test`) cover the access-control matrix (owner / editor / viewer / no access), the 409 conflict path, validation errors, importers, XSS vectors in the sanitizer, version history (throttled snapshots, viewer can't restore, the cross-document version check, restore keeping prior text), and password hashing plus malformed-cookie handling.
- **The importer was checked against a `.docx` produced by a real Word-generation library**, not just the hand-built test fixture, to make sure real-world `numbering.xml` and run properties map correctly.
- **The end-to-end browser run** checked formatting round trips through save → reload, the viewer read-only state, the error toast for unsupported uploads, and the two-user conflict banner. It also confirmed no unexpected console errors.
- **Visual review of screenshots** at each step, which is how the toolbar layout issue was found.
-  I read through each file line by line, deployed to Render, and ran the reviewer path on the live URL".*

## Principle

AI helped construct the first draft. Its output was trusted only once it was backed by a test, by a real-browser check, and by a source (Render's docs). Every bug in the "changed" list was found by verification, not by re-prompting.
