/**
 * PageReader — extracts a structured, minimal, agent-readable snapshot of the
 * current page (DOM + form state + a lightweight a11y-style interaction map).
 *
 * Produces:
 *   {
 *     url, title, lang, charset,
 *     summary:   { text, headings, forms, links, buttons, inputs, images },
 *     dom:       a compact textual representation the agent can reason over,
 *     snapshot:  stable string usable as a diff/state key,
 *     interactive: [{selector, tag, type, value, placeholder, name, href, text, aria, role}] 
 *   }
 *
 * This is loaded as a content script AND available to the side panel. It uses
 * only standard browser APIs (no chrome.*) so it also works if injected via
 * scripting.executeScript into frames.
 */

const MAX_DOM_CHARS = 60000;
const MAX_TREE_DEPTH = 6;
const TEXT_CAP = 280;

function esc(s) {
  return String(s).replace(/[<>&\n\t\r]/g, (c) => c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '\n' ? '⏎' : c === '\t' ? '→' : ' ');
}

function cleanText(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
  return true;
}

/**
 * Build the primary interaction/accessibility map: every actionable element
 * with a stable-ish CSS selector + current value. This is what lets Hermes
 * pick an element to click/fill without coordinate guessing.
 */
function collectInteractive(root = document) {
  const out = [];
  const seen = new Set();
  const q = (sel, max = 1500) => Array.from(root.querySelectorAll(sel)).slice(0, max);

  const push = (el) => {
    if (!isVisible(el)) return;
    // Dedupe by element (best effort)
    if (seen.has(el)) return;
    seen.add(el);
    let sel = '';
    try { sel = cssPath(el); } catch { sel = ''; }
    const ref = `e${out.length + 1}`;
    try { el.setAttribute('data-hermes-ref', ref); } catch {}
    out.push({
      ref,
      tag: el.tagName.toLowerCase(),
      selector: sel,
      id: el.id || '',
      name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : (el.tagName === 'SELECT' ? 'select' : '')),
      value: (el.value !== undefined && '' + el.value !== '') ? cleanText(String(el.value)).slice(0, 200) : '',
      placeholder: el.getAttribute('placeholder') || '',
      href: el.href ? el.href.slice(0, 500) : '',
      text: el.tagName === 'INPUT' ? '' : cleanText(el.textContent || '').slice(0, TEXT_CAP),
      aria: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || ''
    });
  };

  (q('a,button,input,select,textarea,summary,details,[role="button"],[role="link"],[contenteditable="true"]', 2000)).forEach(push);
  return out;
}

// Compact accessibility-style view inspired by BrowserOS snapshots. Refs are
// regenerated on each snapshot because page mutations invalidate them.
function buildAccessibilityTree(root = document) {
  const lines = [];
  const nodes = root.querySelectorAll('h1,h2,h3,a,button,input,select,textarea,[role="button"],[role="link"]');
  for (const node of nodes) {
    if (!isVisible(node)) continue;
    const ref = node.getAttribute('data-hermes-ref') || '';
    const role = node.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }[node.tagName] || node.tagName.toLowerCase());
    const label = cleanText(node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.textContent || node.value || '').slice(0, 180);
    lines.push(`[${ref}] ${role}${label ? `: ${label}` : ''}`);
  }
  return lines.join('\n');
}

/** A compact CSS path for an element (best-effort, id or nth-of-type chain). */
function cssPath(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) {
    const id = el.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (id) return '#' + id;
  }
  if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 6 && node.tagName !== 'BODY') {
    let part = node.tagName.toLowerCase();
    if (node.className && typeof node.className === 'string') {
      const cls = node.className.trim().split(/\s+/).slice(0, 2).map((c) => c.replace(/[^a-zA-Z0-9_-]/g, '_')).filter(Boolean).join('.');
      if (cls) part += '.' + cls;
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** Textual DOM tree, compact. */
function buildDomText(root = document.body, depth = 0, budget = { used: 0 }) {
  if (!root || budget.used > MAX_DOM_CHARS) return '';
  let s = '';
  const children = Array.from(root.children || []).filter(isVisible).slice(0, 120);
  const tag = root.tagName ? root.tagName.toLowerCase() : '#document';
  const pad = '  '.repeat(depth);

  // Only enter text for leaf-ish / structural nodes; skip huge noise.
  let attr = '';
  if (root.tagName) {
    const a = [];
    if (root.id) a.push(`#${root.id}`);
    if (root.className && typeof root.className === 'string') a.push(`.${root.className.trim().split(/\s+/).slice(0,3).join('.')}`);
    if (root.tagName === 'A') a.push(`→${cleanText(root.getAttribute('href')||'')}`);
    if ((root.tagName === 'INPUT' || root.tagName === 'TEXTAREA' || root.tagName === 'SELECT')) {
      a.push(root.tagName === 'INPUT' ? `value="${cleanText(String(root.value||'')).slice(0,60)}"` : '');
    }
    if (a.length) attr = a.filter(Boolean).join('');
  }

  // Decide: is this a text leaf worth emitting inline?
  const ownText = Array.from(root.childNodes).filter((n) => n.nodeType === 3).map((n) => cleanText(n.textContent || '')).filter(Boolean).join(' ');
  const inline = !['DIV','SPAN','SECTION','ARTICLE','MAIN','HEADER','FOOTER','NAV','UL','OL','FORM','ASIDE'].includes((root.tagName||'').toUpperCase());

  let line = '';
  if (root.tagName) {
    line = `${pad}<${tag}${attr ? ' ' + attr : ''}>`;
    if (ownText) line += ` ${esc(ownText).slice(0, TEXT_CAP)}`;
    if (inline || !children.length) {
      line += inline && ownText ? '' : children.length ? '' : '';
      if (!children.length) line += `</${tag}>`;
    }
  }
  s += line;
  budget.used += s.length + 1;
  if (budget.used > MAX_DOM_CHARS) { s += '\n…[truncated]…'; budget.used = MAX_DOM_CHARS + 1; return s; }
  s += '\n';

  for (const c of children) {
    if (depth < MAX_TREE_DEPTH) s += buildDomText(c, depth + 1, budget);
  }
  if (tag && (inline || !children.length) && !children.length) { /* already closed above */ }
  else if (root.tagName && !inline && depth < MAX_TREE_DEPTH) {
    s += `${pad}</${tag}>\n`;
  }
  return s;
}

function summary(root = document) {
  const text = cleanText((root.body ? root.body.innerText || '' : root.innerText || '')).slice(0, 12000);
  const h1 = Array.from(root.querySelectorAll('h1,h2')).map((h) => cleanText(h.textContent)).filter(Boolean).slice(0, 12);
  const forms = root.querySelectorAll('form').length;
  const links = isVisible ? Array.from(root.querySelectorAll('a[href]')).filter(isVisible).length : 0;
  return { text, headings: h1, forms, links, buttons: root.querySelectorAll('button').length, inputs: root.querySelectorAll('input,textarea,select').length, images: root.querySelectorAll('img').length };
}

function collectPageSignals(root = document) {
  const out = [];
  const seen = new Set();
  const nodes = root.querySelectorAll('[aria-live],[role="alert"],[role="status"],[role="log"],[aria-label],[title],[hidden],[aria-hidden="true"]');
  for (const node of nodes) {
    const text = cleanText(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '');
    if (!text || seen.has(text)) continue;
    const lower = text.toLowerCase();
    if (node.getAttribute('aria-live') || ['alert','status','log'].includes(node.getAttribute('role')) || /reply|hidden|spam|muted|unread|filtered|blocked|message|notification|show more|load more/.test(lower)) {
      seen.add(text);
      out.push({ text: text.slice(0, 500), role: node.getAttribute('role') || '', live: node.getAttribute('aria-live') || '', hidden: node.hidden || node.getAttribute('aria-hidden') === 'true' });
    }
  }
  return out.slice(0, 100);
}

/**
 * Snapshot the page. Returns the full structured context object.
 */
function readPage() {
  const root = document;
  const s = summary(root);
  const interactive = collectInteractive(root);
  const accessibility = buildAccessibilityTree(root);
  const dom = buildDomText(root.body, 0, { used: 0 });

  const snapshot = {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || '',
    charset: document.characterSet || '',
    summary: s,
    interactive,
    accessibility,
    signals: collectPageSignals(root),
    dom,
    capturedAt: Date.now()
  };
  return snapshot;
}

/** A short stable key for change detection. */
function snapshotKey() {
  return `${location.href}|${document.title}|${(document.body ? cleanText(document.body.innerText||'') : '').slice(0, 200)}`;
}

// Auto-register for content-script usage when loaded directly (not via ESM import).
if (typeof globalThis !== 'undefined' && !globalThis.__AGUI_PAGE_READER_LOADED__) {
  globalThis.__AGUI_PAGE_READER_LOADED__ = true;
  globalThis.HermesPageReader = { readPage, snapshotKey, collectInteractive, cssPath, isVisible };
}