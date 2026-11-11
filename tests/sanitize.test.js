// Sanitizer tests: the security boundary for all stored document HTML.
// Covers what must survive (formatting) and what must not (scripts, attributes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, htmlToText } from '../server/sanitize.js';

test('keeps supported rich-text formatting', () => {
  const html = '<h1>Title</h1><p><strong>b</strong> <em>i</em> <u>u</u></p><ul><li>one</li></ul><ol><li>two</li></ol>';
  assert.equal(sanitizeHtml(html), html);
});

test('normalizes browser execCommand output (b/i/div) to semantic tags', () => {
  assert.equal(sanitizeHtml('<div><b>x</b><i>y</i></div>'), '<p><strong>x</strong><em>y</em></p>');
});

test('removes scripts, event handlers and dangerous attributes', () => {
  const dirty =
    '<p onclick="steal()" style="color:red">hi</p><script>alert(1)</script>' +
    '<img src=x onerror=alert(1)><a href="javascript:alert(1)">link</a><iframe src="//evil"></iframe>';
  const clean = sanitizeHtml(dirty);
  // <script> is removed with its content; <a> is removed but its text ("link") is kept
  assert.equal(clean, '<p>hi</p>link');
  assert.doesNotMatch(clean, /script|onerror|onclick|javascript|iframe|style/i);
});

test('handles quoted ">" inside attributes without leaking markup', () => {
  // A naive parser would end the tag at the ">" inside the quotes
  // and treat the rest of the attributes as text
  const clean = sanitizeHtml('<img alt=">" onerror="alert(1)">safe');
  assert.equal(clean, 'safe');
});

test('escapes stray angle brackets and preserves valid entities', () => {
  // "&amp;" is kept as-is (not double-escaped to "&amp;amp;"); the bare "&" is escaped
  assert.equal(sanitizeHtml('1 < 2 &amp; 3 > 2 & x'), '1 &lt; 2 &amp; 3 &gt; 2 &amp; x');
});

test('balances unclosed and stray tags', () => {
  // <strong> is never closed, so it gets closed for us; the stray </em> is dropped
  assert.equal(sanitizeHtml('<p><strong>open</p></em>'), '<p><strong>open</strong></p>');
});

test('un-nests lists that contenteditable placed inside <p> and drops empty paragraphs', () => {
  // Real output from Chrome when starting a list on an empty line.
  // <p><br></p> is a blank line the user typed, so it's kept.
  const chromeOutput = '<h2>M</h2><p><ul><li>a</li></ul><p><ol><li>b</li></ol></p></p><p><br></p>';
  assert.equal(sanitizeHtml(chromeOutput), '<h2>M</h2><ul><li>a</li></ul><ol><li>b</li></ol><p><br></p>');
});

test('drops comments and unknown tags but keeps their text', () => {
  assert.equal(sanitizeHtml('<!-- x --><span class="a">text</span><font>more</font>'), 'textmore');
});

test('htmlToText produces a readable snippet', () => {
  assert.equal(htmlToText('<h1>A</h1><p>b &amp; c</p><ul><li>d</li></ul>'), 'A b & c d');
  // Text the user literally typed as "&lt;" must not turn into "<" (no double decoding)
  assert.equal(htmlToText('<p>&amp;lt;</p>'), '&lt;');
});