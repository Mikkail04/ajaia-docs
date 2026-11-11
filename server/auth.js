import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sessions last 7 days

// Prepared SQL statements, created once per database and reused (same pattern as app.js).
// A WeakMap keyed by the db lets each database (e.g. one per test) get its own set.
const statementCache = new WeakMap();

function queriesFor(db) {
  let queries = statementCache.get(db);
  if (!queries) {
    queries = {
      insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
      userForSession: db.prepare(
        `SELECT u.id, u.email, u.name, s.expires_at FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      ),
      deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    };
    statementCache.set(db, queries);
  }
  return queries;
}

// Hash a password with scrypt and a random salt. Stored as "salt:hash" (hex).
// scrypt is deliberately slow, which makes brute-forcing stolen hashes expensive.
export function hashPassword(password) {
  const salt = randomBytes(16); // unique per password, so equal passwords get different hashes
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Check a password against a stored "salt:hash"
export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false; // malformed stored value
  const expected = Buffer.from(hashHex, 'hex');
  // Re-hash the attempt with the same salt and length
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  // Constant-time compare, so response timing doesn't reveal how many bytes matched
  return timingSafeEqual(expected, actual);
}

// Create a session for a user. Returns the token (stored in the cookie) and its lifetime.
export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex'); // 256 random bits: unguessable
  queriesFor(db).insertSession.run(token, userId, Date.now() + SESSION_TTL_MS);
  return { token, maxAgeSeconds: SESSION_TTL_MS / 1000 }; // cookies use seconds, not ms
}

// Look up the signed-in user for a session token; null if missing or expired
export function userForToken(db, token) {
  if (!token) return null;
  const queries = queriesFor(db);
  const row = queries.userForSession.get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    // Expired: clean it up and treat the user as signed out
    queries.deleteSession.run(token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name }; // never expose the password hash
}

// Sign out: delete the session so the token stops working
export function destroySession(db, token) {
  if (token) queriesFor(db).deleteSession.run(token);
}

// Parse a Cookie header ("a=1; b=2") into { a: '1', b: '2' }
export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('='); // split on the first '=' only; values may contain '='
    if (separatorIndex < 0) continue; // skip malformed parts
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Skip values that aren't valid URI encoding instead of failing the whole request
    }
  }
  return cookies;
}
