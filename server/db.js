import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashPassword } from './auth.js';

// Database schema. Every statement uses IF NOT EXISTS, so this runs safely on every start
// and adds any new tables to an existing database.
const SCHEMA = `
-- SQLite only enforces foreign keys (and ON DELETE CASCADE) when this is on, per connection
PRAGMA foreign_keys = ON;

-- Users (seeded demo accounts; no sign-up flow)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL
);

-- Login sessions; the token is stored in the user's cookie
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- Documents; content is sanitized HTML, version is bumped on every save
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);

-- Who a document is shared with, and how (the owner is on documents, not here)
CREATE TABLE IF NOT EXISTS document_shares (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('editor','viewer')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares(user_id);

-- Version history snapshots; created_by is who wrote that content
CREATE TABLE IF NOT EXISTS document_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  content_html TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id, id);
`;

// Demo accounts (also shown on the login page)
export const DEMO_PASSWORD = 'demo1234';
export const DEMO_USERS = [
  { email: 'lena@ajaia.dev', name: 'Lena Fischer' },
  { email: 'ravi@ajaia.dev', name: 'Ravi Menon' },
  { email: 'grace@ajaia.dev', name: 'Grace Holt' },
];

// Sample document owned by Lena and shared with Ravi, so sharing can be tried right away
const WELCOME_TITLE = 'Welcome to Ajaia Docs';
const WELCOME_HTML =
  '<h1>Welcome to Ajaia Docs</h1>' +
  '<p>This is a <strong>sample document</strong> owned by Lena and shared with Ravi as an <em>editor</em>.</p>' +
  '<h2>Try these</h2>' +
  '<ul><li>Format text with <strong>bold</strong>, <em>italic</em> and <u>underline</u></li>' +
  '<li>Switch between headings and normal text</li><li>Import a .txt, .md or .docx file</li></ul>' +
  '<ol><li>Click <strong>Share</strong></li><li>Pick a teammate</li><li>Sign in as them to see it under "Shared with me"</li></ol>';

// Open (or create) the database file, apply the schema and seed demo data if it's empty
export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true }); // make sure data/ exists
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  seed(db);
  return db;
}

// Insert demo users and the welcome document, only on a brand-new database
function seed(db) {
  const queries = {
    countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
    insertUser: db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)'),
    insertDoc: db.prepare('INSERT INTO documents (owner_id, title, content_html, updated_by) VALUES (?, ?, ?, ?)'),
    insertShare: db.prepare('INSERT INTO document_shares (document_id, user_id, role) VALUES (?, ?, ?)'),
  };

  if (queries.countUsers.get().count > 0) return; // already seeded

  // All demo users share one password, so hash it once (scrypt is slow on purpose)
  const passwordHash = hashPassword(DEMO_PASSWORD);

  // Transaction: seed everything or nothing, so a crash can't leave a half-seeded database
  db.exec('BEGIN');
  try {
    const [lenaId, raviId] = DEMO_USERS.map((user) =>
      Number(queries.insertUser.run(user.email, user.name, passwordHash).lastInsertRowid),
    );
    const welcomeDocId = Number(queries.insertDoc.run(lenaId, WELCOME_TITLE, WELCOME_HTML, lenaId).lastInsertRowid);
    queries.insertShare.run(welcomeDocId, raviId, 'editor');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}