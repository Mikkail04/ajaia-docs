// Importer tests: converting uploaded .txt, .md and .docx files into editor HTML,
// and rejecting files we can't handle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importFile, ImportError } from '../server/importers/index.js';
import { markdownToHtml } from '../server/importers/markdown.js';

test('markdown: headings, emphasis, lists, code and quotes', () => {
  const markdown = [
    '# Title',
    '',
    'Some **bold**, *italic*, _also italic_ and `code`.',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted',
    '',
    '```',
    '<b>not html</b>', // inside a code block this must stay visible text, not markup
    '```',
    '#### deep heading', // the editor only has H1-H3, so H4+ becomes H3
  ].join('\n');
  assert.equal(
    markdownToHtml(markdown),
    '<h1>Title</h1>' +
      '<p>Some <strong>bold</strong>, <em>italic</em>, <em>also italic</em> and <code>code</code>.</p>' +
      '<ul><li>one</li><li>two</li></ul>' +
      '<ol><li>first</li><li>second</li></ol>' +
      '<blockquote><p>quoted</p></blockquote>' +
      '<pre><code>&lt;b&gt;not html&lt;/b&gt;</code></pre>' +
      '<h3>deep heading</h3>',
  );
});

test('markdown: snake_case words are not italicised', () => {
  assert.equal(markdownToHtml('use my_var_name here'), '<p>use my_var_name here</p>');
});

test('txt: paragraphs and line breaks, HTML is escaped', () => {
  // Blank line = new paragraph, single newline = <br>
  const { title, html } = importFile('notes.txt', Buffer.from('Line one\nLine two\n\n<script>x</script>'));
  assert.equal(title, 'notes'); // file name without the extension
  assert.equal(html, '<p>Line one<br>Line two</p><p>&lt;script&gt;x&lt;/script&gt;</p>');
});

test('docx: headings, run formatting, bullet vs numbered lists, escaping', () => {
  // Small hand-built .docx covering: Title/Heading styles, bold/italic/underline runs,
  // an explicitly turned-off bold ("not bold"), XML entities, and one bulleted plus
  // one numbered list (told apart via numbering.xml)
  const file = readFileSync(new URL('./fixtures/sample.docx', import.meta.url));
  const { title, html } = importFile('Quarterly Plan.docx', file);
  assert.equal(title, 'Quarterly Plan');
  assert.equal(
    html,
    '<h1>Quarterly Plan</h1><h1>Goals</h1>' +
      '<p>We will <strong>ship</strong> the <em>editor</em> and <u>test</u> it. not bold &amp; done &lt;3</p>' +
      '<ul><li>First bullet</li><li>Second bullet</li></ul>' +
      '<ol><li>Step one</li><li>Step two</li></ol>' +
      '<h2>Details</h2><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
  );
});

test('rejects unsupported, empty, oversized and corrupt files with clear errors', () => {
  assert.throws(() => importFile('photo.png', Buffer.from('x')), (err) => err instanceof ImportError && err.status === 415);
  assert.throws(() => importFile('empty.txt', Buffer.alloc(0)), (err) => err instanceof ImportError && /empty/.test(err.message));
  // 3 MB of the letter "a" (byte 97): over the 2 MB limit
  assert.throws(() => importFile('big.txt', Buffer.alloc(3 * 1024 * 1024, 97)), (err) => err.status === 413);
  assert.throws(() => importFile('bad.docx', Buffer.from('not a zip at all, definitely')), (err) => err.status === 422);
});