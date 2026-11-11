import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, hashPassword, verifyPassword } from '../server/auth.js';

test('parseCookies reads normal cookies and skips malformed ones', () => {
  assert.deepEqual(parseCookies('sid=abc; theme=dark'), { sid: 'abc', theme: 'dark' });
  assert.deepEqual(parseCookies('token=a=b'), { token: 'a=b' }, 'only the first "=" separates name and value');
  // A badly encoded cookie from anywhere on the domain must not break every request
  assert.deepEqual(parseCookies('bad=%E0%A4%A; sid=abc'), { sid: 'abc' });
  assert.deepEqual(parseCookies(), {});
});

test('password hashing: salted, verifiable, rejects wrong passwords', () => {
  const a = hashPassword('demo1234');
  const b = hashPassword('demo1234');
  assert.notEqual(a, b, 'same password gets a different salt each time');
  assert.equal(verifyPassword('demo1234', a), true);
  assert.equal(verifyPassword('wrong', a), false);
  assert.equal(verifyPassword('demo1234', 'not-a-hash'), false);
});