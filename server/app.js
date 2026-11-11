import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, DEMO_USERS, DEMO_PASSWORD } from './db.js';
import { createSession, userForToken, destroySession, parseCookies, verifyPassword } from './auth.js';
import { sanitizeHtml, htmlToText } from './sanitize.js';
import { importFile, ImportError, MAX_UPLOAD_BYTES, SUPPORTED_EXTENSIONS } from './importers/index.js';

// Limits and settings
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url)); // front-end files
const MAX_JSON_BYTES = 1.5 * 1024 * 1024; // max JSON request body
const MAX_CONTENT_CHARS = 1_000_000; // max stored document size
const MAX_TITLE_CHARS = 200;
const COOKIE = 'sid'; // session cookie name
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000; // min time between automatic version snapshots
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 }; // higher role includes lower permissions

// File extension -> Content-Type for static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Error with an HTTP status; the server turns it into a JSON error response
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra; // extra fields merged into the error JSON
  }
}

// Helper Functions

// Send a JSON response
function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', // API responses are never cached
    ...headers,
  });
  res.end(payload);
}

// Read the raw request body, rejecting anything over `limit` bytes
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body too large (limit ${Math.round(limit / 1024)} KB)`));
        req.destroy(); // stop receiving data
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parse a JSON body; must be a plain object
async function readJson(req) {
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    // Requiring JSON also forces a CORS preflight for cross-site requests (cheap CSRF defence).
    throw new HttpError(415, 'Expected Content-Type: application/json');
  }
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (!buf.length) return {};
  try {
    const data = JSON.parse(buf.toString('utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
}

// Validate a title: collapse whitespace, enforce length, fall back if empty
function cleanTitle(value, fallback = 'Untitled document') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new HttpError(400, 'title must be a string');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length > MAX_TITLE_CHARS) throw new HttpError(400, `title must be at most ${MAX_TITLE_CHARS} characters`);
  return trimmed || fallback;
}

// Sanitize document HTML and enforce the size limit
function cleanContent(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'content must be a string of HTML');
  const html = sanitizeHtml(value);
  if (html.length > MAX_CONTENT_CHARS) throw new HttpError(413, 'Document is too large (1 MB limit)');
  return html;
}

// Turn a URL id into a positive integer; anything invalid is a 404 ("<label> not found")
function parseId(raw, label = 'Document') {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, `${label} not found`);
  return id;
}

// App

// Build the HTTP server. Tests pass their own dbPath to use a temporary database.
export function createApp({ dbPath = process.env.DB_PATH || join(process.cwd(), 'data', 'ajaia.db') } = {}) {
  const db = openDatabase(dbPath);

  // Prepared SQL statements: compiled once, reused; `?` placeholders prevent SQL injection
  const queries = {
    // Users
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    allUsers: db.prepare('SELECT id, name, email FROM users ORDER BY name'),

    // One document, with owner and last-editor names
    doc: db.prepare(
      `SELECT d.*, o.name AS owner_name, o.email AS owner_email, ub.name AS updated_by_name
       FROM documents d JOIN users o ON o.id = d.owner_id
       LEFT JOIN users ub ON ub.id = d.updated_by WHERE d.id = ?`,
    ),

    // Sharing
    shareRole: db.prepare('SELECT role FROM document_shares WHERE document_id = ? AND user_id = ?'),
    shares: db.prepare(
      `SELECT u.id AS userId, u.name, u.email, s.role FROM document_shares s
       JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY u.name`,
    ),

    // Dashboard lists: docs I own (with share count) and docs shared with me
    owned: db.prepare(
      `SELECT d.id, d.title, d.content_html, d.updated_at, d.owner_id, o.name AS owner_name,
              (SELECT COUNT(*) FROM document_shares s WHERE s.document_id = d.id) AS share_count
       FROM documents d JOIN users o ON o.id = d.owner_id
       WHERE d.owner_id = ? ORDER BY d.updated_at DESC`,
    ),
    shared: db.prepare(
      `SELECT d.id, d.title, d.content_html, d.updated_at, d.owner_id, o.name AS owner_name, s.role
       FROM document_shares s JOIN documents d ON d.id = s.document_id JOIN users o ON o.id = d.owner_id
       WHERE s.user_id = ? ORDER BY d.updated_at DESC`,
    ),

    // Document writes
    insertDoc: db.prepare('INSERT INTO documents (owner_id, title, content_html, updated_by) VALUES (?, ?, ?, ?)'),
    // Only updates if `version` still matches (optimistic concurrency), then bumps it
    updateDoc: db.prepare(
      `UPDATE documents SET title = ?, content_html = ?, version = version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?
       WHERE id = ? AND version = ?`,
    ),
    deleteDoc: db.prepare('DELETE FROM documents WHERE id = ?'),

    // Share writes: insert, or change the role if already shared
    upsertShare: db.prepare(
      `INSERT INTO document_shares (document_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT(document_id, user_id) DO UPDATE SET role = excluded.role`,
    ),
    deleteShare: db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?'),

    // Version history
    lastSnapshot: db.prepare(
      'SELECT created_at, created_by FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT 1',
    ),
    insertSnapshot: db.prepare(
      'INSERT INTO document_versions (document_id, title, content_html, created_by) VALUES (?, ?, ?, ?)',
    ),
    // List without content (kept light); newest first
    listVersions: db.prepare(
      `SELECT v.id, v.title, v.created_at, u.name AS created_by_name
       FROM document_versions v LEFT JOIN users u ON u.id = v.created_by
       WHERE v.document_id = ? ORDER BY v.id DESC`,
    ),
    // One version; document_id check stops reading another doc's versions (IDOR)
    getVersion: db.prepare(
      `SELECT v.id, v.title, v.content_html, v.created_at, u.name AS created_by_name
       FROM document_versions v LEFT JOIN users u ON u.id = v.created_by
       WHERE v.id = ? AND v.document_id = ?`,
    ),
  };

  // Save the current content as a version if forced, if it's the first one,
  // if the last is over 5 min old, or if a different person is now editing.
  function maybeSnapshot(doc, editorId, { force = false } = {}) {
    const last = queries.lastSnapshot.get(doc.id);

    // `!last` comes first so `last.created_at` is never read when there's no snapshot
    if (force || !last || Date.now() - Date.parse(last.created_at) > SNAPSHOT_EVERY_MS || doc.updated_by !== editorId) {
      // Credit whoever wrote this content (updated_by), not the person triggering the snapshot
      queries.insertSnapshot.run(doc.id, doc.title, doc.content_html, doc.updated_by);
    }
  }

  // The user's role on a document: 'owner' | 'editor' | 'viewer' | null
  function accessFor(doc, user) {
    if (!doc || !user) return null;
    if (doc.owner_id === user.id) return 'owner';
    return queries.shareRole.get(doc.id, user.id)?.role ?? null;
  }

  // Load a document and enforce the minimum role. No access -> 404 so ids don't leak.
  function loadDoc(id, user, need = 'viewer') {
    const doc = queries.doc.get(id);
    const role = accessFor(doc, user);
    if (!role) throw new HttpError(404, 'Document not found');
    if (ROLE_RANK[role] < ROLE_RANK[need]) {
      throw new HttpError(403, need === 'owner' ? 'Only the owner can do that' : 'You have view-only access to this document');
    }
    return { doc, role };
  }

  // Database row -> API response for a full document (camelCase)
  function toDocResponse(doc, role) {
    return {
      id: doc.id,
      title: doc.title,
      content: doc.content_html,
      version: doc.version,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      updatedBy: doc.updated_by_name ?? null,
      owner: { id: doc.owner_id, name: doc.owner_name, email: doc.owner_email },
      role,
      shares: queries.shares.all(doc.id),
    };
  }

  // Database row -> dashboard card (text snippet instead of full HTML)
  function toDocCard(row, role) {
    return {
      id: row.id,
      title: row.title,
      snippet: htmlToText(row.content_html).slice(0, 140),
      updatedAt: row.updated_at,
      owner: { id: row.owner_id, name: row.owner_name },
      role,
      shareCount: row.share_count ?? undefined, // only set for owned docs
    };
  }

  // Signed-in user or 401
  function requireUser(req) {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    return req.user;
  }

  // Router

  // Tiny router: turns '/api/documents/:id' into a regex and records param names
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/:(\w+)/g, (_, key) => {
          keys.push(key);
          return '([^/]+)';
        }) +
        '/?$', // anchor the end, so '/documents/:id' doesn't also match '/documents/1/versions'
    );
    routes.push({ method, re, keys, handler });
  };

  // Auth Routes

  // Health check for the hosting platform
  route('GET', '/api/health', () => ({ status: 200, body: { ok: true } }));

  // Demo accounts for the login page buttons
  route('GET', '/api/demo-users', () => ({
    status: 200,
    body: { password: DEMO_PASSWORD, users: DEMO_USERS },
  }));

  // Sign in: check password, create a session, set an HttpOnly cookie
  route('POST', '/api/login', async (req) => {
    const { email, password } = await readJson(req);
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      throw new HttpError(400, 'Email and password are required');
    }
    const user = queries.userByEmail.get(email.trim());
    // Same message for unknown email and wrong password, so accounts can't be probed
    if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Invalid email or password');
    const { token, maxAgeSeconds } = createSession(db, user.id);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''; // HTTPS-only cookie when deployed
    return {
      status: 200,
      body: { user: { id: user.id, name: user.name, email: user.email } },
      headers: { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}` },
    };
  });

  // Sign out: delete the session and clear the cookie
  route('POST', '/api/logout', (req) => {
    destroySession(db, req.token);
    return { status: 204, headers: { 'Set-Cookie': `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0` } };
  });

  // Returns { user: null } when signed out, so the SPA can check its session without a 401.
  route('GET', '/api/me', (req) => ({ status: 200, body: { user: req.user } }));

  // All users, for the share picker
  route('GET', '/api/users', (req) => {
    requireUser(req);
    return { status: 200, body: { users: queries.allUsers.all() } };
  });

  // Document Routes

  // Dashboard: owned and shared documents
  route('GET', '/api/documents', (req) => {
    const user = requireUser(req);
    return {
      status: 200,
      body: {
        owned: queries.owned.all(user.id).map((row) => toDocCard(row, 'owner')),
        shared: queries.shared.all(user.id).map((row) => toDocCard(row, row.role)),
      },
    };
  });

  // Create a document (the creator is the owner)
  route('POST', '/api/documents', async (req) => {
    const user = requireUser(req);
    const data = await readJson(req);
    const title = cleanTitle(data.title);
    const content = data.content === undefined ? '' : cleanContent(data.content);
    const id = Number(queries.insertDoc.run(user.id, title, content, user.id).lastInsertRowid);
    return { status: 201, body: { document: toDocResponse(queries.doc.get(id), 'owner') } };
  });

  // Open a document (any role)
  route('GET', '/api/documents/:id', (req, params) => {
    const user = requireUser(req);
    const { doc, role } = loadDoc(parseId(params.id), user);
    return { status: 200, body: { document: toDocResponse(doc, role) } };
  });

  // Save edits / rename (owner/editor). Requires the version the client edited.
  route('PATCH', '/api/documents/:id', async (req, params) => {
    const user = requireUser(req);
    const { doc, role } = loadDoc(parseId(params.id), user, 'editor');
    const data = await readJson(req);
    if (!Number.isInteger(data.version)) throw new HttpError(400, 'version (integer) is required');
    if (data.title === undefined && data.content === undefined) throw new HttpError(400, 'Nothing to update');

    // Keep the existing value for any field not sent
    const title = data.title === undefined ? doc.title : cleanTitle(data.title);
    const content = data.content === undefined ? doc.content_html : cleanContent(data.content);

    // Transaction: a rejected save (409) also undoes its snapshot
    db.exec('BEGIN');
    try {
      maybeSnapshot(doc, user.id);
      // Optimistic concurrency: only apply if the client edited the latest version.
      const result = queries.updateDoc.run(title, content, user.id, doc.id, data.version);
      if (result.changes === 0) {
        // Someone saved first: send back their copy so the UI can offer a choice
        const current = queries.doc.get(doc.id);
        throw new HttpError(409, `This document was changed by ${current.updated_by_name || 'someone else'} since you opened it`, {
          document: toDocResponse(current, role),
        });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { status: 200, body: { document: toDocResponse(queries.doc.get(doc.id), role) } };
  });

  // Delete a document (owner only); shares and versions cascade
  route('DELETE', '/api/documents/:id', (req, params) => {
    const user = requireUser(req);
    const { doc } = loadDoc(parseId(params.id), user, 'owner');
    queries.deleteDoc.run(doc.id);
    return { status: 204 };
  });

  // Sharing Routes

  // Share or change someone's role (owner only)
  route('POST', '/api/documents/:id/shares', async (req, params) => {
    const user = requireUser(req);
    const { doc } = loadDoc(parseId(params.id), user, 'owner');
    const { email, role } = await readJson(req);
    if (typeof email !== 'string' || !email.trim()) throw new HttpError(400, 'email is required');
    if (!['editor', 'viewer'].includes(role)) throw new HttpError(400, 'role must be "editor" or "viewer"');
    const target = queries.userByEmail.get(email.trim());
    if (!target) throw new HttpError(404, `No user with email ${email.trim()}`);
    if (target.id === doc.owner_id) throw new HttpError(400, 'The owner already has full access');
    queries.upsertShare.run(doc.id, target.id, role);
    return { status: 200, body: { shares: queries.shares.all(doc.id) } };
  });

  // Remove access. Owners can revoke anyone; collaborators can remove themselves ("leave").
  route('DELETE', '/api/documents/:id/shares/:userId', (req, params) => {
    const user = requireUser(req);
    const targetId = parseId(params.userId, 'User');
    const need = targetId === user.id ? 'viewer' : 'owner';
    const { doc } = loadDoc(parseId(params.id), user, need);
    queries.deleteShare.run(doc.id, targetId);
    return { status: 200, body: { shares: queries.shares.all(doc.id) } };
  });

  // Version History Routes

  // Version history list (any role)
  route('GET', '/api/documents/:id/versions', (req, params) => {
    const user = requireUser(req);
    const { doc } = loadDoc(parseId(params.id), user);
    const versions = queries.listVersions.all(doc.id);

    return {
      status: 200,
      body: {
        versions: versions.map((version) => ({
          id: version.id,
          title: version.title,
          createdAt: version.created_at,
          createdBy: version.created_by_name,
        })),
      },
    };
  });

  // One version with content, for the preview (any role)
  route('GET', '/api/documents/:id/versions/:versionId', (req, params) => {
    const user = requireUser(req);
    const { doc } = loadDoc(parseId(params.id), user);

    const version = queries.getVersion.get(parseId(params.versionId, 'Version'), doc.id);
    if (!version) throw new HttpError(404, 'Version not found');

    return {
      status: 200,
      body: {
        version: {
          id: version.id,
          title: version.title,
          content: version.content_html,
          createdAt: version.created_at,
          createdBy: version.created_by_name,
        },
      },
    };
  });

  // Restore a version (owner/editor). Adds history instead of erasing it.
  route('POST', '/api/documents/:id/versions/:versionId/restore', (req, params) => {
    const user = requireUser(req);
    const { doc, role } = loadDoc(parseId(params.id), user, 'editor');

    const version = queries.getVersion.get(parseId(params.versionId, 'Version'), doc.id);
    if (!version) throw new HttpError(404, 'Version not found');

    // Snapshot + overwrite succeed or fail together
    db.exec('BEGIN');
    try {
      // Save what's there now, so the restore itself can be undone.
      maybeSnapshot(doc, user.id, { force: true });
      queries.updateDoc.run(version.title, version.content_html, user.id, doc.id, doc.version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return { status: 200, body: { document: toDocResponse(queries.doc.get(doc.id), role) } };
  });

  // Import Routes

  // Upload a file -> new document.
  route('POST', '/api/import', async (req) => {
    const user = requireUser(req);
    const { title, html } = await importFromRequest(req);
    const id = Number(queries.insertDoc.run(user.id, title, html, user.id).lastInsertRowid);
    return { status: 201, body: { document: toDocResponse(queries.doc.get(id), 'owner') } };
  });

  // Upload a file -> converted HTML to insert into an existing document (client inserts + autosaves).
  route('POST', '/api/documents/:id/import', async (req, params) => {
    const user = requireUser(req);
    loadDoc(parseId(params.id), user, 'editor');
    const { title, html } = await importFromRequest(req);
    return { status: 200, body: { title, html } };
  });

  // Read an uploaded file (raw body + X-Filename header) and convert it to HTML
  async function importFromRequest(req) {
    const rawName = req.headers['x-filename'];
    if (!rawName) throw new HttpError(400, 'Missing X-Filename header');
    let filename;
    try {
      filename = decodeURIComponent(String(rawName)); // the client URL-encodes the name
    } catch {
      throw new HttpError(400, 'Invalid X-Filename header');
    }
    const buf = await readBody(req, MAX_UPLOAD_BYTES + 1); // +1 so the importer reports "too large"
    try {
      return importFile(filename, buf);
    } catch (err) {
      if (err instanceof ImportError) throw new HttpError(err.status, err.message, { supported: SUPPORTED_EXTENSIONS });
      throw err;
    }
  }

  // Static Files

  // Serve files from public/; unknown paths without an extension get index.html (SPA)
  async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !extname(rel)) rel = '/index.html'; // SPA fallback
    const file = normalize(join(PUBLIC_DIR, rel));
    // Block path traversal (e.g. /../server/db.js)
    if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) return send(res, 404, { error: 'Not found' });
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error();
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache', // always revalidate, so updates show up
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      send(res, 404, { error: 'Not found' });
    }
  }

  // Server

  const server = createServer(async (req, res) => {
    // Security headers on every response
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY'); // no embedding in iframes
    // CSP: only load scripts/styles from this site, which blocks injected scripts
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );

    const url = new URL(req.url, 'http://localhost');
    try {
      // Non-API paths are static files
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        return await serveStatic(req, res, url.pathname);
      }

      // Look up the signed-in user from the session cookie
      req.token = parseCookies(req.headers.cookie)[COOKIE];
      req.user = userForToken(db, req.token);

      // Find a matching route; path match + wrong method = 405, no match = 404
      let matchedPath = false;
      for (const entry of routes) {
        const match = entry.re.exec(url.pathname);
        if (!match) continue;
        matchedPath = true;
        if (entry.method !== req.method) continue;
        const params = Object.fromEntries(entry.keys.map((key, index) => [key, match[index + 1]]));
        const out = await entry.handler(req, params);
        return send(res, out.status, out.status === 204 ? undefined : out.body, out.headers);
      }
      throw new HttpError(matchedPath ? 405 : 404, matchedPath ? 'Method not allowed' : 'Not found');
    } catch (err) {
      // Expected errors -> their status; anything else -> logged 500 without internals
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong on our side' });
    }
  });

  server.on('close', () => db.close()); // close the database with the server
  return server;
}
