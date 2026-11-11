// Ajaia Docs: vanilla JS single page app (no framework, no build step)
import { cleanHtml } from './clean-html.js';

// Settings
const SUPPORTED_EXTENSIONS = '.txt,.md,.markdown,.docx'; // for the file picker's `accept`
const SUPPORTED_LABEL = '.txt, .md or .docx (max 2 MB)'; // shown to users
const AUTOSAVE_DELAY_MS = 700; // save after this much idle time while typing
const POLL_INTERVAL_MS = 8000; // how often an open document checks for others' changes

const app = document.getElementById('app');

// App-wide state: the signed-in user and the open editor (if any)
const state = { me: null, editor: null, focusTitle: false };

// Utilities

// Error from the API, carrying the HTTP status and response body
class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

// Call the API. Sends JSON by default; `raw: true` sends the body as-is (file uploads).
async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: raw ? headers : { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: 'Network error. Check your connection.' }); // status 0 = offline
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    // Session expired mid-use: send the user back to the login screen
    if (response.status === 401 && state.me && path !== '/api/login') {
      state.me = null;
      toast('Your session expired. Please sign in again.', 'error');
      renderLogin();
    }
    throw new ApiError(response.status, data);
  }
  return data;
}

// Create a DOM element: h('button', { class: 'btn', onclick: fn }, 'Label', childElement)
// ("h" for "hyperscript", the usual name for this kind of helper)
function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue; // skip unset attributes
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value); // onclick -> click
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (value === true) element.setAttribute(key, ''); // boolean attributes like `disabled`
    else element.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue; // allows `condition && h(...)`
    // Strings become text nodes, never HTML, so user content can't inject markup
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

// Inline SVG icon by name
function icon(name) {
  const paths = {
    back: 'M15 18l-6-6 6-6',
    ul: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
    ol: 'M10 6h10M10 12h10M10 18h10M4 4.5h1.5V9M3.8 9h3M3.8 14.2c.4-.6 1-.9 1.6-.9.8 0 1.4.5 1.4 1.2 0 1.2-3 2-3 3.5h3',
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
    redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
    quote: 'M7 17h3l2-4V7H6v6h3zM15 17h3l2-4V7h-6v6h3z',
    clear: 'M4 7V5h12v2M10 5l-3 14M14 14l6 6M20 14l-6 6',
    upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
    plus: 'M12 5v14M5 12h14',
    share: 'M16 8a3 3 0 100-6 3 3 0 000 6zM8 15a3 3 0 100-6 3 3 0 000 6zM16 22a3 3 0 100-6 3 3 0 000 6zM10.6 13.5l2.8 1.8M13.4 6.7l-2.8 1.8',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    doc: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true'); // decorative; buttons carry their own labels
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]);
  svg.append(path);
  return svg;
}

// Show a short message at the bottom of the screen
function toast(message, kind = 'info', durationMs = 4000) {
  const element = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(element);
  setTimeout(() => element.classList.add('leaving'), durationMs); // fade out
  setTimeout(() => element.remove(), durationMs + 300);
}

// "just now", "5 min ago", "3 h ago", or a date
function timeAgo(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// "Lena Fischer" -> "LF" for avatars
function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
}

// Role id -> label shown in the UI
function roleLabel(role) {
  return { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }[role] || role;
}

// Open the browser's file picker; resolves with the chosen file (or null)
function pickFile() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: SUPPORTED_EXTENSIONS, class: 'sr-only' });
    input.addEventListener('change', () => {
      resolve(input.files[0] || null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

// Upload a file as the raw request body; the name goes in a header
function uploadTo(path, file) {
  return api(path, {
    method: 'POST',
    raw: true,
    body: file,
    headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
  });
}

// Routing

// Go to a hash route; re-renders even if we're already there
function navigate(hash) {
  if (location.hash === hash) router();
  else location.hash = hash;
}

// Pick the screen from the URL hash: #/d/<id> is the editor, anything else the dashboard
async function router() {
  teardownEditor();
  if (!state.me) return renderLogin();
  const match = /^#\/d\/(\d+)$/.exec(location.hash);
  if (match) return renderEditor(Number(match[1]));
  return renderDashboard();
}

window.addEventListener('hashchange', router);

// Top bar

// Shared header: logo, optional middle content, current user and "Switch user"
function topBar(...middle) {
  return h(
    'header',
    { class: 'topbar' },
    h('a', { href: '#/', class: 'brand', 'aria-label': 'Ajaia Docs home' }, h('img', { src: '/favicon.svg', alt: '' }), h('span', {}, 'Ajaia Docs')),
    h('div', { class: 'topbar-middle' }, ...middle),
    h(
      'div',
      { class: 'topbar-user' },
      h('span', { class: 'avatar', title: `${state.me.name} (${state.me.email})` }, initials(state.me.name)),
      h('span', { class: 'user-name' }, state.me.name),
      h('button', { class: 'btn ghost small', onclick: signOut }, 'Switch user'),
    ),
  );
}

async function signOut() {
  await api('/api/logout', { method: 'POST' }).catch(() => {}); // sign out locally even if the request fails
  state.me = null;
  location.hash = '#/';
  renderLogin();
}

// Login

async function renderLogin() {
  teardownEditor();
  const error = h('p', { class: 'form-error', hidden: true });
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true, placeholder: 'you@ajaia.dev' });
  const password = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
  const demoList = h('div', { class: 'demo-list' });

  // Sign in with the form fields, or with `credentials` from a demo button
  async function login(e, credentials) {
    e?.preventDefault();
    error.hidden = true;
    const body = credentials || { email: email.value, password: password.value };
    if (!body.email || !body.password) {
      error.textContent = 'Enter your email and password.';
      error.hidden = false;
      return;
    }
    try {
      const { user } = await api('/api/login', { method: 'POST', body });
      state.me = user;
      router();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  }

  app.replaceChildren(
    h(
      'main',
      { class: 'login' },
      h(
        'div',
        { class: 'login-card' },
        h('div', { class: 'login-brand' }, h('img', { src: '/favicon.svg', alt: '' }), h('h1', {}, 'Ajaia Docs')),
        h('p', { class: 'muted' }, 'Write, format and share documents with your team.'),
        h(
          'form',
          { onsubmit: login, novalidate: true },
          h('label', { for: 'email' }, 'Email'),
          email,
          h('label', { for: 'password' }, 'Password'),
          password,
          error,
          h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in'),
        ),
        h('div', { class: 'divider' }, h('span', {}, 'or use a demo account')),
        demoList,
      ),
    ),
  );

  // One-click demo account buttons
  try {
    const { users, password: demoPassword } = await api('/api/demo-users');
    demoList.replaceChildren(
      ...users.map((user) =>
        h(
          'button',
          { class: 'demo-user', type: 'button', onclick: (e) => login(e, { email: user.email, password: demoPassword }) },
          h('span', { class: 'avatar' }, initials(user.name)),
          h('span', { class: 'demo-meta' }, h('strong', {}, user.name), h('small', {}, user.email)),
        ),
      ),
      h('p', { class: 'hint center' }, `All demo accounts use the password "${demoPassword}".`),
    );
  } catch {
    // The demo list is optional; the form still works without it
  }
  email.focus();
}

// Dashboard

async function renderDashboard() {
  const owned = h('div', { class: 'doc-grid' }, h('p', { class: 'muted' }, 'Loading…'));
  const shared = h('div', { class: 'doc-grid' });

  const createDoc = async () => {
    try {
      const { document } = await api('/api/documents', { method: 'POST', body: { title: 'Untitled document' } });
      state.focusTitle = true; // select the title so the user can rename it straight away
      navigate(`#/d/${document.id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  // Import a file as a new document (from the picker, or a dropped file)
  const importDoc = async (file) => {
    file = file || (await pickFile());
    if (!file) return;
    try {
      const { document } = await uploadTo('/api/import', file);
      toast(`Imported "${document.title}"`, 'success');
      navigate(`#/d/${document.id}`);
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
  };

  const startSection = h(
    'section',
    { class: 'start' },
    h('h2', { class: 'section-title' }, 'Start a new document'),
    h(
      'div',
      { class: 'start-row' },
      h('button', { class: 'start-card', onclick: createDoc }, h('span', { class: 'start-icon' }, icon('plus')), h('span', {}, 'Blank document')),
      h(
        'button',
        { class: 'start-card', onclick: () => importDoc() },
        h('span', { class: 'start-icon' }, icon('upload')),
        h('span', {}, 'Import a file'),
        h('small', {}, SUPPORTED_LABEL),
      ),
      h('p', { class: 'hint drop-hint' }, 'Tip: you can also drag a .txt, .md or .docx file anywhere on this page.'),
    ),
  );

  app.replaceChildren(
    topBar(),
    h(
      'main',
      { class: 'dashboard' },
      startSection,
      h('section', {}, h('h2', { class: 'section-title' }, 'My documents'), owned),
      h('section', {}, h('h2', { class: 'section-title' }, 'Shared with me'), shared),
    ),
  );

  // Drag & drop import
  const main = app.querySelector('.dashboard');
  main.addEventListener('dragover', (e) => {
    e.preventDefault(); // required to allow dropping
    main.classList.add('dragging');
  });
  main.addEventListener('dragleave', (e) => {
    if (e.target === main) main.classList.remove('dragging'); // ignore leaving child elements
  });
  main.addEventListener('drop', (e) => {
    e.preventDefault(); // stop the browser from opening the file
    main.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file) importDoc(file);
  });

  try {
    const data = await api('/api/documents');
    owned.replaceChildren(
      ...(data.owned.length
        ? data.owned.map((doc) => docCard(doc, renderDashboard))
        : [h('p', { class: 'empty' }, 'No documents yet. Create one or import a file.')]),
    );
    shared.replaceChildren(
      ...(data.shared.length
        ? data.shared.map((doc) => docCard(doc, renderDashboard))
        : [h('p', { class: 'empty' }, 'Nothing has been shared with you yet.')]),
    );
  } catch (err) {
    owned.replaceChildren(h('p', { class: 'form-error' }, `Could not load documents: ${err.message}`));
  }
}

// One document card on the dashboard; `refresh` re-renders the list after a delete
function docCard(doc, refresh) {
  const isOwner = doc.role === 'owner';
  const deleteDoc = async (e) => {
    e.preventDefault(); // the card is a link; don't open the document
    e.stopPropagation();
    if (!confirm(`Delete "${doc.title}"? This also removes access for anyone it is shared with.`)) return;
    try {
      await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
      toast('Document deleted');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return h(
    'a',
    { class: 'doc-card', href: `#/d/${doc.id}` },
    h('div', { class: 'doc-preview' }, doc.snippet || h('span', { class: 'muted' }, 'Empty document')),
    h(
      'div',
      { class: 'doc-meta' },
      h('div', { class: 'doc-title' }, icon('doc'), h('span', {}, doc.title)),
      h(
        'div',
        { class: 'doc-sub' },
        isOwner
          ? h('span', { class: `badge ${doc.shareCount ? 'shared' : ''}` }, doc.shareCount ? `Shared with ${doc.shareCount}` : 'Private')
          : h('span', { class: 'badge role' }, `${doc.owner.name} · ${roleLabel(doc.role)}`),
        h('span', { class: 'muted' }, timeAgo(doc.updatedAt)),
        isOwner && h('button', { class: 'icon-btn danger', title: 'Delete document', 'aria-label': `Delete ${doc.title}`, onclick: deleteDoc }, icon('trash')),
      ),
    ),
  );
}

// Editor

// Clean up the open editor (timers, listeners) before showing another screen
function teardownEditor() {
  const editor = state.editor;
  if (!editor) return;
  clearTimeout(editor.saveTimer);
  clearInterval(editor.pollTimer);
  document.removeEventListener('selectionchange', editor.onSelection);
  window.removeEventListener('beforeunload', editor.onBeforeUnload);
  if (editor.dirty && editor.canEdit) editor.flush(); // best-effort save when leaving
  state.editor = null;
}

async function renderEditor(id) {
  app.replaceChildren(topBar(), h('main', { class: 'editor-loading' }, h('p', { class: 'muted' }, 'Opening document…')));
  let doc;
  try {
    ({ document: doc } = await api(`/api/documents/${id}`));
  } catch (err) {
    app.replaceChildren(
      topBar(),
      h(
        'main',
        { class: 'editor-loading' },
        h('h2', {}, err.status === 404 ? 'Document not found' : 'Could not open document'),
        h('p', { class: 'muted' }, err.status === 404 ? "It may have been deleted, or it hasn't been shared with you." : err.message),
        h('a', { class: 'btn', href: '#/' }, 'Back to documents'),
      ),
    );
    return;
  }

  // Editor state, shared with teardownEditor and the dialogs
  const canEdit = doc.role !== 'viewer';
  const editor = {
    id,
    doc,
    version: doc.version, // the version our next save is based on
    canEdit,
    dirty: false, // unsaved changes
    saving: false, // a save request is in flight
    queued: false, // another save is needed after the current one
    conflict: false, // someone else saved first; waiting for the user to choose
    saveTimer: null,
    pollTimer: null,
  };
  state.editor = editor;

  // Elements
  const title = h('input', {
    class: 'title-input',
    value: doc.title,
    maxlength: 200,
    'aria-label': 'Document title',
    readonly: !canEdit,
    title: canEdit ? 'Rename document' : doc.title,
  });
  const status = h('span', { class: 'save-status', 'aria-live': 'polite' }, 'All changes saved');
  const body = h('div', {
    class: 'page-body',
    contenteditable: canEdit ? 'true' : 'false',
    spellcheck: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': 'Document content',
    'data-placeholder': canEdit ? 'Start typing…' : '',
  });
  body.innerHTML = doc.content; // server-sanitized (allowlist, no attributes)
  const banner = h('div', { class: 'banner', hidden: true });
  const wordCount = h('span', { class: 'muted' });

  const shareButton =
    doc.role === 'owner'
      ? h('button', { class: 'btn primary', onclick: () => openShareDialog(editor) }, icon('share'), 'Share')
      : h('button', { class: 'btn ghost', onclick: () => openShareDialog(editor) }, `Shared by ${doc.owner.name}`);

  const historyButton = h('button', { class: 'btn ghost', onclick: () => openHistoryDialog(editor) }, 'History');

  const roleChip = h('span', { class: `badge role-chip ${doc.role}` }, roleLabel(doc.role));

  // Saving

  function setStatus(text, kind = '') {
    status.textContent = text;
    status.className = `save-status ${kind}`;
  }

  // Called on every edit: restart the autosave timer
  function markDirty() {
    if (!canEdit || editor.conflict) return;
    editor.dirty = true;
    setStatus('Unsaved changes…');
    clearTimeout(editor.saveTimer);
    editor.saveTimer = setTimeout(save, AUTOSAVE_DELAY_MS);
    updateWordCount();
  }

  // Save to the server. Only one request at a time; edits made meanwhile trigger one more save.
  async function save() {
    if (!editor.dirty || editor.conflict || state.editor !== editor) return;
    if (editor.saving) {
      editor.queued = true;
      return;
    }
    editor.saving = true;
    editor.dirty = false;
    setStatus('Saving…');
    try {
      const { document: saved } = await api(`/api/documents/${id}`, {
        method: 'PATCH',
        body: { title: title.value, content: body.innerHTML, version: editor.version },
      });
      editor.version = saved.version;
      editor.doc = saved;
      setStatus('All changes saved', 'ok');
    } catch (err) {
      if (err.status === 409) {
        showConflict(err); // someone else saved first
      } else if (err.status === 0 || err.status >= 500) {
        // Offline or server error: keep the changes and retry
        editor.dirty = true;
        setStatus('Offline. Retrying…', 'warn');
        clearTimeout(editor.saveTimer);
        editor.saveTimer = setTimeout(save, 3000);
      } else {
        editor.dirty = true;
        setStatus('Not saved', 'error');
        toast(err.message, 'error', 6000);
      }
    } finally {
      editor.saving = false;
      if (editor.queued) {
        editor.queued = false;
        save();
      }
    }
  }

  // Fire-and-forget save used when navigating away; keepalive lets it finish after the page closes
  editor.flush = () => {
    fetch(`/api/documents/${id}`, {
      method: 'PATCH',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.value, content: body.innerHTML, version: editor.version }),
    }).catch(() => {}); // nothing useful to do if it fails while leaving
  };

  // Someone saved first: let the user load their version or overwrite it
  function showConflict(err) {
    editor.conflict = true;
    const server = err.data?.document;
    setStatus('Conflict', 'error');
    banner.hidden = false;
    banner.className = 'banner warn';
    banner.replaceChildren(
      h('span', {}, `${err.message}. Your latest edits were not saved.`),
      h(
        'span',
        { class: 'banner-actions' },
        h('button', { class: 'btn small', onclick: () => applyServer(server) }, 'Load their version'),
        h(
          'button',
          {
            class: 'btn small primary',
            onclick: () => {
              // Save ours on top of theirs: adopt their version number and save again
              editor.version = server.version;
              editor.conflict = false;
              editor.dirty = true;
              banner.hidden = true;
              save();
            },
          },
          'Keep mine (overwrite)',
        ),
      ),
    );
  }

  // Replace the editor's title, content and version with a copy from the server
  function applyServer(server) {
    editor.conflict = false;
    editor.dirty = false;
    editor.version = server.version;
    editor.doc = server;
    title.value = server.title;
    body.innerHTML = server.content;
    banner.hidden = true;
    setStatus('All changes saved', 'ok');
    updateWordCount();
  }
  editor.applyServer = applyServer; // used by the history dialog after a restore

  // Lightweight "collaboration": poll for newer versions saved by others.
  editor.pollTimer = setInterval(async () => {
    if (editor.saving || editor.conflict || document.hidden) return;
    try {
      const { document: latest } = await api(`/api/documents/${id}`);
      if (latest.version <= editor.version) {
        editor.doc.shares = latest.shares; // nothing new, but keep the share list current
        return;
      }
      if (!editor.dirty && document.activeElement !== body) {
        // Not typing: update in place
        applyServer(latest);
        toast(`Updated with changes from ${latest.updatedBy || 'a collaborator'}`);
      } else if (!editor.dirty) {
        // Focused but no unsaved changes: offer the update instead of moving their cursor
        banner.hidden = false;
        banner.className = 'banner info';
        banner.replaceChildren(
          h('span', {}, `${latest.updatedBy || 'Someone'} made changes to this document.`),
          h('span', { class: 'banner-actions' }, h('button', { class: 'btn small', onclick: () => applyServer(latest) }, 'Show latest')),
        );
      }
      // With unsaved changes we do nothing here; the next save will report the conflict
    } catch (err) {
      if (err.status === 404) {
        toast('You no longer have access to this document', 'error');
        navigate('#/');
      }
    }
  }, POLL_INTERVAL_MS);

  // Toolbar

  // Run a formatting command on the current selection
  const runCommand = (command, value = null) => {
    if (!canEdit) return;
    body.focus();
    document.execCommand(command, false, value);
    markDirty();
    refreshToolbar();
  };

  // Toggle buttons (bold, lists...) whose pressed state follows the cursor
  const toggleButtons = [];

  // Create a toolbar button
  const toolbarButton = (label, command, options = {}) => {
    const button = h(
      'button',
      {
        type: 'button',
        class: `tb-btn ${options.className || ''}`,
        title: options.title || label,
        'aria-label': options.title || label,
        'aria-pressed': options.toggle ? 'false' : undefined,
        disabled: !canEdit,
        onmousedown: (e) => e.preventDefault(), // keep the text selection
        onclick: options.onclick || (() => runCommand(command, options.value)),
      },
      options.icon ? icon(options.icon) : label,
    );
    if (options.toggle) toggleButtons.push({ button, command });
    return button;
  };

  const blockSelect = h(
    'select',
    {
      class: 'tb-select',
      'aria-label': 'Text style',
      disabled: !canEdit,
      onchange: (e) => runCommand('formatBlock', `<${e.target.value}>`),
    },
    h('option', { value: 'p' }, 'Normal text'),
    h('option', { value: 'h1' }, 'Heading 1'),
    h('option', { value: 'h2' }, 'Heading 2'),
    h('option', { value: 'h3' }, 'Heading 3'),
    h('option', { value: 'blockquote' }, 'Quote'),
    h('option', { value: 'pre' }, 'Code block'),
  );

  // Upload a file and insert its converted content at the cursor
  const insertFromFile = async () => {
    const file = await pickFile();
    if (!file) return;
    try {
      const { html } = await uploadTo(`/api/documents/${id}/import`, file);
      body.focus();
      restoreSelection(); // the file picker took focus, so put the cursor back
      document.execCommand('insertHTML', false, html);
      markDirty();
      toast(`Inserted content from ${file.name}`, 'success');
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
  };

  const toolbar = h(
    'div',
    { class: 'toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
    toolbarButton('Undo', 'undo', { icon: 'undo', title: 'Undo (Ctrl+Z)' }),
    toolbarButton('Redo', 'redo', { icon: 'redo', title: 'Redo (Ctrl+Y)' }),
    h('span', { class: 'tb-sep' }),
    blockSelect,
    h('span', { class: 'tb-sep' }),
    toolbarButton('B', 'bold', { toggle: true, className: 'b', title: 'Bold (Ctrl+B)' }),
    toolbarButton('I', 'italic', { toggle: true, className: 'i', title: 'Italic (Ctrl+I)' }),
    toolbarButton('U', 'underline', { toggle: true, className: 'u', title: 'Underline (Ctrl+U)' }),
    toolbarButton('S', 'strikeThrough', { toggle: true, className: 's', title: 'Strikethrough' }),
    h('span', { class: 'tb-sep' }),
    toolbarButton('Bulleted list', 'insertUnorderedList', { toggle: true, icon: 'ul' }),
    toolbarButton('Numbered list', 'insertOrderedList', { toggle: true, icon: 'ol' }),
    toolbarButton('Clear formatting', 'removeFormat', {
      icon: 'clear',
      onclick: () => {
        runCommand('removeFormat');
        runCommand('formatBlock', '<p>');
      },
    }),
    h('span', { class: 'tb-sep' }),
    h(
      'button',
      {
        type: 'button',
        class: 'tb-btn wide',
        disabled: !canEdit,
        title: `Insert the contents of a ${SUPPORTED_LABEL} file at the cursor`,
        onmousedown: (e) => {
          e.preventDefault();
          saveSelection(); // remember the cursor before the file picker opens
        },
        onclick: insertFromFile,
      },
      icon('upload'),
      h('span', {}, 'Insert from file'),
    ),
  );

  // Remember and restore the cursor position inside the document
  let savedRange = null;
  function saveSelection() {
    const selection = getSelection();
    if (selection.rangeCount && body.contains(selection.anchorNode)) savedRange = selection.getRangeAt(0).cloneRange();
  }
  function restoreSelection() {
    const selection = getSelection();
    selection.removeAllRanges();
    if (savedRange) selection.addRange(savedRange);
    else {
      // No saved position: put the cursor at the end of the document
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      selection.addRange(range);
    }
  }

  // Update pressed buttons and the style dropdown to match the formatting at the cursor
  function refreshToolbar() {
    const selection = getSelection();
    if (!selection.rangeCount || !body.contains(selection.anchorNode)) return;
    for (const { button, command } of toggleButtons) {
      let isActive = false;
      try {
        isActive = document.queryCommandState(command);
      } catch {
        // Some browsers throw for unsupported commands; treat as "off"
      }
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
    const block = String(document.queryCommandValue('formatBlock') || 'p').toLowerCase().replace(/[<>]/g, '');
    blockSelect.value = ['h1', 'h2', 'h3', 'blockquote', 'pre'].includes(block) ? block : 'p';
  }

  function updateWordCount() {
    const words = (body.innerText.match(/\S+/g) || []).length;
    wordCount.textContent = `${words} word${words === 1 ? '' : 's'}`;
  }

  // Events

  editor.onSelection = refreshToolbar;
  document.addEventListener('selectionchange', editor.onSelection);

  // Warn before closing the tab with unsaved changes (and try to save them)
  editor.onBeforeUnload = (e) => {
    if (editor.dirty || editor.saving) {
      editor.flush();
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', editor.onBeforeUnload);

  body.addEventListener('input', markDirty);

  // Paste: clean pasted HTML to the same tags the server allows
  body.addEventListener('paste', (e) => {
    if (!canEdit) return;
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (html) document.execCommand('insertHTML', false, cleanHtml(html));
    else document.execCommand('insertText', false, text);
  });

  // Ctrl/Cmd+S saves now instead of opening the browser's "Save page" dialog
  body.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      clearTimeout(editor.saveTimer);
      save();
    }
  });

  title.addEventListener('input', markDirty);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      body.focus(); // Enter in the title jumps to the document
    }
  });
  title.addEventListener('blur', () => {
    if (!title.value.trim()) {
      title.value = 'Untitled document';
      markDirty();
    }
  });

  if (!canEdit) {
    banner.hidden = false;
    banner.className = 'banner info';
    banner.textContent = `View only. ${doc.owner.name} shared this document with you as a viewer.`;
  }

  app.replaceChildren(
    h(
      'div',
      { class: 'editor-chrome' },
      h(
        'header',
        { class: 'topbar editor-top' },
        h('a', { href: '#/', class: 'icon-btn', title: 'Back to documents', 'aria-label': 'Back to documents' }, icon('back')),
        h('div', { class: 'title-wrap' }, title, h('div', { class: 'title-sub' }, roleChip, status)),
        h(
          'div',
          { class: 'topbar-actions' },
          historyButton,
          shareButton,
          h('span', { class: 'avatar', title: `${state.me.name} (${state.me.email})` }, initials(state.me.name)),
        ),
      ),
      h('div', { class: 'toolbar-row' }, toolbar),
    ),
    h('main', { class: 'editor-main' }, banner, h('article', { class: 'page' }, body), h('footer', { class: 'editor-footer' }, wordCount)),
  );

  document.execCommand('defaultParagraphSeparator', false, 'p'); // Enter creates <p>, not <div>
  updateWordCount();
  if (state.focusTitle && canEdit) {
    title.select();
    state.focusTitle = false;
  } else if (canEdit) body.focus();
}

// Version history dialog

const historyDialog = document.getElementById('history-dialog');
historyDialog.querySelector('[data-close]').addEventListener('click', () => historyDialog.close());
historyDialog.addEventListener('click', (e) => {
  if (e.target === historyDialog) historyDialog.close(); // click on the backdrop closes it
});

// Open the history panel: version list on the left, preview on the right
async function openHistoryDialog(editor) {
  const list = document.getElementById('history-list');
  const preview = document.getElementById('history-preview');
  const restoreButton = document.getElementById('history-restore');
  restoreButton.hidden = true;
  list.replaceChildren(h('li', { class: 'muted' }, 'Loading…'));
  preview.replaceChildren(h('p', { class: 'muted' }, 'Select a version to preview it.'));
  historyDialog.showModal(); // open immediately; the list fills in when it loads

  let versions;
  try {
    ({ versions } = await api(`/api/documents/${editor.id}/versions`));
  } catch (err) {
    list.replaceChildren(h('li', { class: 'form-error' }, err.message));
    return;
  }

  if (!versions.length) {
    list.replaceChildren(h('li', { class: 'muted' }, 'No earlier versions yet. They are saved automatically as you edit.'));
    return;
  }

  // Load one version's content when it's clicked (the list itself has no content)
  async function showVersion(entry, row) {
    for (const item of list.children) item.classList.remove('selected');
    row.classList.add('selected');
    preview.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const { version } = await api(`/api/documents/${editor.id}/versions/${entry.id}`);
      preview.innerHTML = version.content || '<p class="muted">Empty document</p>'; // content was sanitized on save
      restoreButton.hidden = !editor.canEdit; // viewers never see it (and the server would 403 anyway)
      restoreButton.onclick = () => restoreVersion(editor, version);
    } catch (err) {
      preview.replaceChildren(h('p', { class: 'form-error' }, err.message));
    }
  }

  // Exact time rather than "2 min ago", so close versions can be told apart
  const formatTime = (iso) =>
    new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  list.replaceChildren(
    ...versions.map((entry) => {
      const row = h(
        'li',
        {},
        h(
          'button',
          { type: 'button', class: 'history-item', onclick: () => showVersion(entry, row) },
          h('strong', {}, formatTime(entry.createdAt)),
          h('small', {}, `${entry.createdBy || 'Unknown'} · ${entry.title}`),
        ),
      );
      return row;
    }),
  );
}

// Restore a version after confirming; the server snapshots the current text first
async function restoreVersion(editor, version) {
  if (editor.dirty || editor.saving) {
    // A pending autosave would otherwise land on top of the restore
    toast('Wait until your latest changes are saved, then try again.', 'error');
    return;
  }
  const label = new Date(version.createdAt).toLocaleString();
  if (!confirm(`Restore the version from ${label}? Your current text will be kept in the history, so you can undo this.`)) return;

  try {
    const { document } = await api(`/api/documents/${editor.id}/versions/${version.id}/restore`, { method: 'POST' });
    editor.applyServer(document);
    historyDialog.close();
    toast('Version restored', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Share dialog

const shareDialog = document.getElementById('share-dialog');
shareDialog.querySelector('[data-close]').addEventListener('click', () => shareDialog.close());
shareDialog.addEventListener('click', (e) => {
  if (e.target === shareDialog) shareDialog.close(); // click on the backdrop closes it
});

// Owners can add people, change roles and remove access; others see the list and can leave
async function openShareDialog(editor) {
  const isOwner = editor.doc.role === 'owner';
  const form = document.getElementById('share-form');
  const userSelect = document.getElementById('share-email');
  const roleSelect = document.getElementById('share-role');
  const list = document.getElementById('share-list');
  const errorText = document.getElementById('share-error');
  const addRow = document.getElementById('share-add');
  document.getElementById('share-title').textContent = `Share “${editor.doc.title}”`;
  addRow.hidden = !isOwner;
  errorText.hidden = true;

  let users = [];
  try {
    ({ users } = await api('/api/users'));
  } catch (err) {
    toast(err.message, 'error');
  }

  const showError = (message) => {
    errorText.textContent = message;
    errorText.hidden = false;
  };

  // Redraw the "add someone" dropdown and the list of people with access
  function renderShares(shares) {
    editor.doc.shares = shares;
    const sharedIds = new Set(shares.map((collaborator) => collaborator.userId));
    // Only offer people who don't already have access
    const candidates = users.filter((user) => user.id !== editor.doc.owner.id && !sharedIds.has(user.id));
    userSelect.replaceChildren(
      ...(candidates.length
        ? [h('option', { value: '' }, 'Choose a teammate…'), ...candidates.map((user) => h('option', { value: user.email }, `${user.name} (${user.email})`))]
        : [h('option', { value: '' }, 'Everyone already has access')]),
    );
    userSelect.disabled = !candidates.length;

    const ownerRow = h(
      'li',
      {},
      h('span', { class: 'avatar' }, initials(editor.doc.owner.name)),
      h('span', { class: 'share-who' }, h('strong', {}, editor.doc.owner.name), h('small', {}, editor.doc.owner.email)),
      h('span', { class: 'muted' }, 'Owner'),
    );
    const rows = shares.map((collaborator) => {
      // Owners get a role dropdown; everyone else just sees the role
      const roleControl = isOwner
        ? h(
            'select',
            {
              'aria-label': `Access for ${collaborator.name}`,
              onchange: (e) => share(collaborator.email, e.target.value),
            },
            h('option', { value: 'editor', selected: collaborator.role === 'editor' }, 'Can edit'),
            h('option', { value: 'viewer', selected: collaborator.role === 'viewer' }, 'Can view'),
          )
        : h('span', { class: 'muted' }, roleLabel(collaborator.role));
      const isMe = collaborator.userId === state.me.id;
      const canRemove = isOwner || isMe; // owners remove anyone; collaborators can leave
      return h(
        'li',
        {},
        h('span', { class: 'avatar' }, initials(collaborator.name)),
        h('span', { class: 'share-who' }, h('strong', {}, collaborator.name + (isMe ? ' (you)' : '')), h('small', {}, collaborator.email)),
        roleControl,
        canRemove &&
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn danger',
              title: isOwner ? 'Remove access' : 'Leave document',
              'aria-label': isOwner ? `Remove ${collaborator.name}` : 'Leave document',
              onclick: () => unshare(collaborator),
            },
            '✕',
          ),
      );
    });
    list.replaceChildren(ownerRow, ...rows);
  }

  // Add someone or change their role; returns true on success
  async function share(email, role) {
    errorText.hidden = true;
    try {
      const { shares } = await api(`/api/documents/${editor.id}/shares`, { method: 'POST', body: { email, role } });
      renderShares(shares);
      return true;
    } catch (err) {
      showError(err.message);
      return false;
    }
  }

  // Remove someone's access, or leave the document yourself
  async function unshare(collaborator) {
    const leaving = collaborator.userId === state.me.id;
    if (leaving && !confirm('Leave this document? You will lose access until the owner shares it again.')) return;
    try {
      const { shares } = await api(`/api/documents/${editor.id}/shares/${collaborator.userId}`, { method: 'DELETE' });
      if (leaving) {
        shareDialog.close();
        toast('You left the document');
        navigate('#/');
        return;
      }
      renderShares(shares);
      toast(`Removed ${collaborator.name}`);
    } catch (err) {
      showError(err.message);
    }
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!userSelect.value) return showError('Choose a teammate to share with.');
    const chosen = users.find((user) => user.email === userSelect.value);
    if (await share(userSelect.value, roleSelect.value)) toast(`Shared with ${chosen?.name || userSelect.value}`, 'success');
  };

  renderShares(editor.doc.shares || []);
  shareDialog.showModal();
}

// Start-up: check for an existing session, then show the right screen

(async function boot() {
  try {
    const { user } = await api('/api/me');
    state.me = user || null;
  } catch {
    state.me = null;
  }
  router();
})();