// Allowlist HTML sanitizer.
//
// Every document body passes through here before it is stored, so the client can
// safely render stored HTML with innerHTML. The output contains ONLY the tags below
// and NO attributes at all (no style, no href, no on* handlers), which removes the
// whole class of attribute-based XSS. Text is re-escaped and tags are re-balanced.

// Tags that survive sanitizing
const ALLOWED_TAGS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr']);
// Tags with no closing tag
const VOID_TAGS = new Set(['br', 'hr']);
// Block-level tags, which can't be nested inside <p>
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'pre', 'hr']);
// Equivalent tags mapped to the ones we keep (browsers' execCommand produces <b>, <i>, <div>)
const TAG_ALIASES = { b: 'strong', i: 'em', div: 'p', strike: 's', del: 's', h4: 'h3', h5: 'h3', h6: 'h3' };
// Tags whose *content* must be discarded too, not just the tag (e.g. the code inside <script>)
const DROP_WITH_CONTENT = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'title', 'head', 'svg', 'math', 'textarea', 'select']);

// An "&" that isn't already the start of a valid entity like &amp; or &#39;
const BARE_AMPERSAND = /&(?!(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});)/g;

// Escape text so it can't be read as markup (existing valid entities are kept)
export function escapeText(text) {
  return String(text).replace(BARE_AMPERSAND, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Find the '>' that ends the tag starting at `start`, ignoring any '>' inside quoted
// attribute values (e.g. <img alt=">">). Returns -1 if the tag never ends.
function findTagEnd(html, start) {
  let quote = null; // the quote character we're inside, if any
  for (let pos = start + 1; pos < html.length; pos++) {
    const char = html[pos];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return pos;
    }
  }
  return -1;
}

// Sanitize HTML: keep allowed tags (without attributes), escape everything else
export function sanitizeHtml(input) {
  const html = String(input ?? '');
  let output = '';
  const openTags = []; // currently open tags, used to close them in the right order
  let pos = 0;

  while (pos < html.length) {
    // Copy text up to the next '<', escaped
    const tagStart = html.indexOf('<', pos);
    if (tagStart === -1) {
      output += escapeText(html.slice(pos));
      break;
    }
    output += escapeText(html.slice(pos, tagStart));

    // Drop comments entirely
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      pos = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    // Read the tag name: group 1 is '/' for closing tags, group 2 is the name
    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(tagStart, tagStart + 64));

    // Drop declarations and processing instructions like <!DOCTYPE> and <?xml ?>
    if (!match && (html[tagStart + 1] === '!' || html[tagStart + 1] === '?')) {
      const declarationEnd = html.indexOf('>', tagStart);
      pos = declarationEnd === -1 ? html.length : declarationEnd + 1;
      continue;
    }

    // A '<' that doesn't start a tag (e.g. "1 < 2") is just text
    if (!match) {
      output += '&lt;';
      pos = tagStart + 1;
      continue;
    }

    const tagEnd = findTagEnd(html, tagStart);
    if (tagEnd === -1) {
      // Unterminated tag: treat the rest as text.
      output += escapeText(html.slice(tagStart));
      break;
    }
    pos = tagEnd + 1;

    const isClosing = match[1] === '/';
    const rawName = match[2].toLowerCase();

    // Skip dangerous elements and everything up to their closing tag
    if (!isClosing && DROP_WITH_CONTENT.has(rawName)) {
      const closeStart = html.toLowerCase().indexOf(`</${rawName}`, pos);
      if (closeStart === -1) {
        pos = html.length;
      } else {
        const closeEnd = html.indexOf('>', closeStart);
        pos = closeEnd === -1 ? html.length : closeEnd + 1;
      }
      continue;
    }

    const name = TAG_ALIASES[rawName] || rawName;
    if (!ALLOWED_TAGS.has(name)) continue; // drop tag, keep its text content

    // Like a real HTML parser: a block element can't live inside <p>, so close the <p> first.
    // (contenteditable in Chrome sometimes produces <p><ul>…</ul></p>.)
    if (!isClosing && BLOCK_TAGS.has(name) && openTags.includes('p')) {
      const paragraphIndex = openTags.lastIndexOf('p');
      while (openTags.length > paragraphIndex) output += `</${openTags.pop()}>`;
    }

    // <br> and <hr>: emit the opening tag, ignore any closing one
    if (VOID_TAGS.has(name)) {
      if (!isClosing) output += `<${name}>`;
      continue;
    }

    if (!isClosing) {
      output += `<${name}>`; // rebuilt with no attributes
      openTags.push(name);
    } else {
      const openIndex = openTags.lastIndexOf(name);
      if (openIndex === -1) continue; // stray closing tag
      // Close anything opened inside it first, so tags stay properly nested
      while (openTags.length > openIndex) output += `</${openTags.pop()}>`;
    }
  }

  // Close anything left open, then drop empty paragraphs
  while (openTags.length) output += `</${openTags.pop()}>`;
  return output.replace(/<p><\/p>/g, '');
}

// Plain-text version of stored HTML, used for snippets on the dashboard cards
export function htmlToText(html) {
  return String(html)
    .replace(/<(?:br|\/p|\/h[1-3]|\/li|\/blockquote|\/pre)>/g, ' ') // line/block breaks become spaces
    .replace(/<[^>]+>/g, '') // remove remaining tags
    // decode the entities escapeText produces (&amp; last, so "&amp;lt;" stays "&lt;")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}