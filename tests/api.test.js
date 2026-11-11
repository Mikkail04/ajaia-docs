// API integration tests: a real server on a random port, a temporary database
// and real HTTP requests (nothing is mocked).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { DEMO_PASSWORD } from '../server/db.js';

let server;
let baseUrl;
let tempDir;

// Fresh database and server for this file; port 0 lets the OS pick a free port
before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'ajaia-test-'));
  server = createApp({ dbPath: join(tempDir, 'test.db') });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
});

// Sign in as a demo user and return a request function that sends that user's session cookie.
// Each user gets their own function, so one test can act as Lena, Ravi and Grace at once:
//   const lena = await signIn('lena@ajaia.dev');
//   await lena('GET', '/api/documents');
// A Buffer body is sent raw (file uploads); anything else is sent as JSON.
async function signIn(email) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0]; // "sid=<token>"
  return async (method, path, body, extraHeaders = {}) => {
    const isRaw = Buffer.isBuffer(body);
    const result = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Cookie: cookie, ...(body && !isRaw ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      body: isRaw ? body : body ? JSON.stringify(body) : undefined,
    });
    return { status: result.status, body: result.status === 204 ? null : await result.json() };
  };
}

test('rejects unauthenticated requests and bad credentials', async () => {
  assert.equal((await fetch(`${baseUrl}/api/documents`)).status, 401);
  const bad = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'lena@ajaia.dev', password: 'wrong' }),
  });
  assert.equal(bad.status, 401);
});

test('end-to-end: create, edit, share as viewer/editor, revoke', async () => {
  const lena = await signIn('lena@ajaia.dev');
  const ravi = await signIn('ravi@ajaia.dev');
  const grace = await signIn('grace@ajaia.dev');

  // Lena creates a document; content is sanitized on write.
  const created = await lena('POST', '/api/documents', { title: '  Launch plan  ', content: '<p>Hi<script>x</script></p>' });
  assert.equal(created.status, 201);
  const doc = created.body.document;
  assert.equal(doc.title, 'Launch plan');
  assert.equal(doc.content, '<p>Hi</p>');
  assert.equal(doc.role, 'owner');

  // Rename + edit with formatting, persisted across reads.
  const edited = await lena('PATCH', `/api/documents/${doc.id}`, {
    title: 'Launch plan v2',
    content: '<h1>Plan</h1><p><strong>Ship</strong> it</p><ul><li>a</li></ul>',
    version: doc.version,
  });
  assert.equal(edited.status, 200);
  const reread = await lena('GET', `/api/documents/${doc.id}`);
  assert.equal(reread.body.document.title, 'Launch plan v2');
  assert.equal(reread.body.document.content, '<h1>Plan</h1><p><strong>Ship</strong> it</p><ul><li>a</li></ul>');

  // Ravi cannot see it before it is shared (404, so ids don't leak).
  assert.equal((await ravi('GET', `/api/documents/${doc.id}`)).status, 404);
  const raviListBefore = await ravi('GET', '/api/documents');
  assert.ok(!raviListBefore.body.shared.some((item) => item.id === doc.id));

  // Only the owner can share.
  assert.equal((await ravi('POST', `/api/documents/${doc.id}/shares`, { email: 'ravi@ajaia.dev', role: 'editor' })).status, 404);

  // Share with Ravi as viewer: he can read, but not write.
  const shared = await lena('POST', `/api/documents/${doc.id}/shares`, { email: 'ravi@ajaia.dev', role: 'viewer' });
  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.shares.map((share) => [share.email, share.role]), [['ravi@ajaia.dev', 'viewer']]);

  const raviList = await ravi('GET', '/api/documents');
  const entry = raviList.body.shared.find((item) => item.id === doc.id);
  assert.equal(entry.role, 'viewer');
  assert.equal(entry.owner.name, 'Lena Fischer');
  assert.ok(!raviList.body.owned.some((item) => item.id === doc.id), 'shared docs are not listed as owned');

  const raviView = await ravi('GET', `/api/documents/${doc.id}`);
  assert.equal(raviView.body.document.role, 'viewer');
  const raviWrite = await ravi('PATCH', `/api/documents/${doc.id}`, { content: '<p>hack</p>', version: raviView.body.document.version });
  assert.equal(raviWrite.status, 403);

  // Upgrade to editor: now Ravi can write.
  await lena('POST', `/api/documents/${doc.id}/shares`, { email: 'ravi@ajaia.dev', role: 'editor' });
  const raviEdit = await ravi('PATCH', `/api/documents/${doc.id}`, { content: '<p>Ravi was here</p>', version: raviView.body.document.version });
  assert.equal(raviEdit.status, 200);
  assert.equal(raviEdit.body.document.updatedBy, 'Ravi Menon');

  // Editors cannot delete or reshare; Grace still has no access.
  assert.equal((await ravi('DELETE', `/api/documents/${doc.id}`)).status, 403);
  assert.equal((await ravi('POST', `/api/documents/${doc.id}/shares`, { email: 'grace@ajaia.dev', role: 'viewer' })).status, 403);
  assert.equal((await grace('GET', `/api/documents/${doc.id}`)).status, 404);

  // Revoke.
  await lena('DELETE', `/api/documents/${doc.id}/shares/${raviView.body.document.shares[0].userId}`);
  assert.equal((await ravi('GET', `/api/documents/${doc.id}`)).status, 404);
});

test('stale saves are rejected with 409 instead of silently overwriting', async () => {
  const lena = await signIn('lena@ajaia.dev');
  const { body } = await lena('POST', '/api/documents', { title: 'Race' });
  const v1 = body.document.version;

  const first = await lena('PATCH', `/api/documents/${body.document.id}`, { content: '<p>first</p>', version: v1 });
  assert.equal(first.status, 200);

  // Same base version again, as if a second tab saved without seeing the first save
  const stale = await lena('PATCH', `/api/documents/${body.document.id}`, { content: '<p>stale</p>', version: v1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.document.content, '<p>first</p>', 'conflict response includes the current server copy');
});

test('validation errors return 4xx with a message', async () => {
  const lena = await signIn('lena@ajaia.dev');
  assert.equal((await lena('POST', '/api/documents', { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await lena('POST', '/api/documents', { content: 42 })).status, 400);
  const { body } = await lena('POST', '/api/documents', {});
  assert.equal(body.document.title, 'Untitled document');
  assert.equal((await lena('PATCH', `/api/documents/${body.document.id}`, { content: '<p>x</p>' })).status, 400, 'version required');
  assert.equal((await lena('POST', `/api/documents/${body.document.id}/shares`, { email: 'nobody@x.dev', role: 'viewer' })).status, 404);
  assert.equal((await lena('POST', `/api/documents/${body.document.id}/shares`, { email: 'ravi@ajaia.dev', role: 'admin' })).status, 400);
  assert.equal((await lena('GET', '/api/documents/abc')).status, 404);
});

test('uploading a .docx creates an editable document owned by the uploader', async () => {
  const grace = await signIn('grace@ajaia.dev');
  // Small hand-built .docx: title, headings, bold/italic/underline runs, bullet and numbered lists
  const file = readFileSync(new URL('./fixtures/sample.docx', import.meta.url));
  const result = await grace('POST', '/api/import', file, { 'X-Filename': encodeURIComponent('Quarterly Plan.docx') });
  assert.equal(result.status, 201);
  assert.equal(result.body.document.title, 'Quarterly Plan');
  assert.match(result.body.document.content, /<strong>ship<\/strong>/);

  const unsupported = await grace('POST', '/api/import', Buffer.from('x'), { 'X-Filename': 'image.png' });
  assert.equal(unsupported.status, 415);
  assert.match(unsupported.body.error, /Unsupported file type/);
});

test('version history: throttled snapshots, permissions and non-destructive restore', async () => {
  const lena = await signIn('lena@ajaia.dev');
  const ravi = await signIn('ravi@ajaia.dev');

  const { body } = await lena('POST', '/api/documents', { title: 'History', content: '<p>v1</p>' });
  const id = body.document.id;

  // First save snapshots the original; a quick second save by the same person does not.
  // (The test finishes well within the 5-minute snapshot window, so this is deterministic.)
  const s1 = await lena('PATCH', `/api/documents/${id}`, { content: '<p>v2</p>', version: body.document.version });
  await lena('PATCH', `/api/documents/${id}`, { content: '<p>v3</p>', version: s1.body.document.version });

  let list = await lena('GET', `/api/documents/${id}/versions`);
  assert.equal(list.status, 200);
  assert.equal(list.body.versions.length, 1, 'rapid saves by one person create only one snapshot');
  const original = list.body.versions[0];
  assert.equal(original.createdBy, 'Lena Fischer');

  const one = await lena('GET', `/api/documents/${id}/versions/${original.id}`);
  assert.equal(one.body.version.content, '<p>v1</p>');

  // Viewers can read history but cannot restore.
  await lena('POST', `/api/documents/${id}/shares`, { email: 'ravi@ajaia.dev', role: 'viewer' });
  assert.equal((await ravi('GET', `/api/documents/${id}/versions`)).status, 200);
  assert.equal((await ravi('POST', `/api/documents/${id}/versions/${original.id}/restore`)).status, 403);

  // A version can't be read through another document's URL (IDOR guard).
  const other = await lena('POST', '/api/documents', { title: 'Other' });
  assert.equal((await lena('GET', `/api/documents/${other.body.document.id}/versions/${original.id}`)).status, 404);

  // Restore brings back v1, and the pre-restore content (v3) is kept in history.
  const restored = await lena('POST', `/api/documents/${id}/versions/${original.id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.document.content, '<p>v1</p>');

  list = await lena('GET', `/api/documents/${id}/versions`);
  assert.equal(list.body.versions.length, 2, 'restore adds history instead of erasing it');
  const newest = await lena('GET', `/api/documents/${id}/versions/${list.body.versions[0].id}`);
  assert.equal(newest.body.version.content, '<p>v3</p>');
});