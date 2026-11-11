import { extname, basename } from 'node:path';
import { markdownToHtml } from './markdown.js';
import { docxToHtml } from './docx.js';
import { escapeText, sanitizeHtml } from '../sanitize.js';

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx'];
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export class ImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function textToHtml(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeText(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function decodeUtf8(buffer) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (text.includes('\u0000')) throw new ImportError('File looks binary, not text', 415);
  return text.replace(/^﻿/, '');
}

/** Convert an uploaded file into { title, html }. html is always sanitized. */
export function importFile(filename, buffer) {
  const safeName = basename(String(filename || '')).slice(0, 200);
  const ext = extname(safeName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new ImportError(`Unsupported file type "${ext || 'none'}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`, 415);
  }
  if (!buffer || buffer.length === 0) throw new ImportError('The file is empty');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new ImportError('File is larger than 2 MB', 413);

  let html;
  if (ext === '.txt') html = textToHtml(decodeUtf8(buffer));
  else if (ext === '.md' || ext === '.markdown') html = markdownToHtml(decodeUtf8(buffer));
  else {
    try {
      html = docxToHtml(buffer);
    } catch (err) {
      throw new ImportError(`Could not read .docx file: ${err.message}`, 422);
    }
  }

  html = sanitizeHtml(html);
  if (!html) html = '<p></p>';
  const title = safeName.slice(0, safeName.length - ext.length).trim() || 'Imported document';
  return { title: title.slice(0, 200), html };
}
