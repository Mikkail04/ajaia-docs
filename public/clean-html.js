// Client-side cleanup for pasted HTML. Mirrors the server allowlist (server/sanitize.js)
// so pasted content looks the same before and after a save. The server remains the
// security boundary; this is only for a consistent editing experience.

const ALLOWED = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'STRONG', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE', 'HR']);
const ALIASES = { B: 'strong', I: 'em', DIV: 'p', STRIKE: 's', DEL: 's', H4: 'h3', H5: 'h3', H6: 'h3' };
const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TITLE', 'HEAD', 'SVG', 'MATH', 'META', 'LINK']);

export function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const out = document.createDocumentFragment();
  walk(doc.body, out);
  const div = document.createElement('div');
  div.append(out);
  return div.innerHTML;
}

function walk(src, dest) {
  for (const node of src.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      dest.append(document.createTextNode(node.textContent));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (DROP.has(node.tagName)) continue;
      const style = node.getAttribute('style') || '';
      let tag = ALIASES[node.tagName] || (ALLOWED.has(node.tagName) ? node.tagName.toLowerCase() : null);
      // Google Docs / Word wrap formatting in <span style="font-weight:700">
      if (!tag && node.tagName === 'SPAN') {
        let inner = dest;
        const wrap = (t) => {
          const el = document.createElement(t);
          inner.append(el);
          inner = el;
        };
        if (/font-weight:\s*(bold|[6-9]00)/.test(style)) wrap('strong');
        if (/font-style:\s*italic/.test(style)) wrap('em');
        if (/text-decoration[^;]*underline/.test(style)) wrap('u');
        walk(node, inner);
        continue;
      }
      // Google Docs wraps the whole paste in <b style="font-weight:normal">
      if (tag === 'strong' && /font-weight:\s*(normal|400)/.test(style)) tag = null;
      if (!tag) {
        walk(node, dest);
        continue;
      }
      const el = document.createElement(tag);
      dest.append(el);
      walk(node, el);
    }
  }
}
