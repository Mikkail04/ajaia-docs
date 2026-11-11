import { readZipEntry } from './zip.js';
import { escapeText } from '../sanitize.js';

/**
 * .docx -> HTML. Reads word/document.xml (and numbering.xml for list types) and maps:
 *   Title / Heading1..3 paragraph styles -> h1..h3
 *   numbered paragraphs (w:numPr)         -> <ul>/<ol> (flat, nesting is flattened)
 *   run properties b / i / u / strike     -> strong / em / u / s
 * Images, tables layout, comments, footnotes and fonts are intentionally dropped
 * (table cell text is kept as paragraphs).
 */
export function docxToHtml(buffer) {
  const docXml = readZipEntry(buffer, 'word/document.xml');
  if (!docXml) throw new Error('This .docx has no word/document.xml');
  const numberingXml = readZipEntry(buffer, 'word/numbering.xml');
  const listTypes = parseNumbering(numberingXml ? numberingXml.toString('utf8') : '');

  const xml = docXml.toString('utf8');
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;

  const blocks = [];
  const paraRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = paraRe.exec(body))) {
    const p = m[1];
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(p)?.[1] ?? '';
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pPr)?.[1] ?? '';
    const numId = /<w:numId\s+w:val="(\d+)"/.exec(pPr)?.[1];
    const content = runsToHtml(p);
    if (!content.replace(/<br>/g, '').trim()) continue;

    const heading = /^(?:Heading|heading\s?)(\d)$/.exec(style);
    if (style === 'Title') blocks.push({ tag: 'h1', content });
    else if (style === 'Subtitle') blocks.push({ tag: 'h2', content });
    else if (heading) blocks.push({ tag: `h${Math.min(Number(heading[1]), 3)}`, content });
    else if (numId && numId !== '0') blocks.push({ tag: 'li', list: listTypes.get(numId) || 'ul', content });
    else if (/^ListBullet/.test(style)) blocks.push({ tag: 'li', list: 'ul', content });
    else if (/^ListNumber/.test(style)) blocks.push({ tag: 'li', list: 'ol', content });
    else if (/^(Quote|IntenseQuote)$/.test(style)) blocks.push({ tag: 'blockquote', content: `<p>${content}</p>` });
    else blocks.push({ tag: 'p', content });
  }

  let html = '';
  let openList = null;
  for (const b of blocks) {
    if (b.tag === 'li') {
      if (openList !== b.list) {
        if (openList) html += `</${openList}>`;
        html += `<${b.list}>`;
        openList = b.list;
      }
      html += `<li>${b.content}</li>`;
      continue;
    }
    if (openList) {
      html += `</${openList}>`;
      openList = null;
    }
    html += `<${b.tag}>${b.content}</${b.tag}>`;
  }
  if (openList) html += `</${openList}>`;
  return html;
}

function runsToHtml(paragraphXml) {
  let html = '';
  const runRe = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
  let m;
  while ((m = runRe.exec(paragraphXml))) {
    const run = m[1];
    const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? '';
    let text = '';
    const partRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t\s*\/>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\s*\/>/g;
    let part;
    while ((part = partRe.exec(run))) {
      const tok = part[0];
      if (tok.startsWith('<w:tab')) text += '\t';
      else if (tok.startsWith('<w:br') || tok.startsWith('<w:cr')) text += '\n';
      else if (part[1] !== undefined) text += decodeXml(part[1]);
    }
    if (!text) continue;
    let piece = escapeText(text).replace(/\n/g, '<br>');
    if (isOn(rPr, 'strike') || isOn(rPr, 'dstrike')) piece = `<s>${piece}</s>`;
    if (/<w:u\s+w:val="(?!none")[^"]*"/.test(rPr) || /<w:u\s*\/>/.test(rPr)) piece = `<u>${piece}</u>`;
    if (isOn(rPr, 'i')) piece = `<em>${piece}</em>`;
    if (isOn(rPr, 'b')) piece = `<strong>${piece}</strong>`;
    html += piece;
  }
  return html;
}

function isOn(rPr, prop) {
  const m = new RegExp(`<w:${prop}(?:\\s+w:val="([^"]*)")?\\s*/>`).exec(rPr);
  if (!m) return false;
  return m[1] === undefined || !/^(0|false|off)$/i.test(m[1]);
}

function parseNumbering(xml) {
  const abstractFmt = new Map();
  const absRe = /<w:abstractNum\s[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g;
  let m;
  while ((m = absRe.exec(xml))) {
    const lvl0 = /<w:lvl\s[^>]*w:ilvl="0"[^>]*>([\s\S]*?)<\/w:lvl>/.exec(m[2])?.[1] ?? m[2];
    const fmt = /<w:numFmt\s+w:val="([^"]+)"/.exec(lvl0)?.[1] ?? 'bullet';
    abstractFmt.set(m[1], fmt === 'bullet' || fmt === 'none' ? 'ul' : 'ol');
  }
  const map = new Map();
  const numRe = /<w:num\s[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g;
  while ((m = numRe.exec(xml))) {
    const abs = /<w:abstractNumId\s+w:val="(\d+)"/.exec(m[2])?.[1];
    map.set(m[1], abstractFmt.get(abs) || 'ul');
  }
  return map;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}
