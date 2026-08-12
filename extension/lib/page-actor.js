/**
 * PageActor — executes DOM actions on behalf of Hermes in the active page.
 *
 * Hermes' browser tools commonly refer to accessibility elements as @e1, @e2,
 * etc. PageReader stores the same ids in data-hermes-ref attributes, so this
 * actor resolves both @e1 and e1 before falling back to CSS/text matching.
 */

const OUTPUT_LIMIT = 25000;
const DEFAULT_WAIT_MS = 1000;
const MAX_WAIT_MS = 30000;

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

const INTERACTIVE_SEL = 'a,button,input,select,textarea,summary,details,[role="button"],[role="link"],[contenteditable="true"]';

function refSelector(value) {
  const match = String(value || '').trim().match(/^@?(e\d+)$/i);
  return match ? `[data-hermes-ref="${match[1]}"]` : '';
}

function refIndex(value) {
  const match = String(value || '').trim().match(/^@?e(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function restampRefs(root = document) {
  const reader = globalThis.HermesPageReader;
  if (reader && typeof reader.readPage === 'function') {
    try { reader.readPage(); return; } catch {}
  }
  const nodes = Array.from(root.querySelectorAll(INTERACTIVE_SEL)).filter((node) => {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 || box.height > 0;
  });
  nodes.forEach((node, index) => {
    try { node.setAttribute('data-hermes-ref', `e${index + 1}`); } catch {}
  });
}

function nodeLabel(node) {
  return cleanText(
    node.getAttribute('aria-label')
    || node.getAttribute('placeholder')
    || node.getAttribute('title')
    || node.getAttribute('name')
    || node.value
    || node.textContent
    || ''
  );
}

function lookupEl(raw, root) {
  const ref = refSelector(raw);
  if (ref) {
    const byRef = root.querySelector(ref);
    if (byRef) return byRef;
  }

  try {
    const found = root.querySelector(raw);
    if (found) return found;
  } catch {}

  const index = refIndex(raw);
  if (index > 0) {
    const stamped = root.querySelector(`[data-hermes-ref="e${index}"]`);
    if (stamped) return stamped;
    const listed = Array.from(root.querySelectorAll(INTERACTIVE_SEL)).filter((node) => {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const box = node.getBoundingClientRect();
      return box.width > 0 || box.height > 0;
    });
    if (listed[index - 1]) return listed[index - 1];
  }

  const needle = raw.replace(/^@/, '').toLowerCase();
  if (!needle) return null;
  const candidates = Array.from(root.querySelectorAll(INTERACTIVE_SEL));
  return candidates.find((node) => nodeLabel(node).toLowerCase() === needle)
    || candidates.find((node) => {
      const text = nodeLabel(node).toLowerCase();
      return text.includes(needle) || needle.includes(text);
    })
    || null;
}

function el(selector, root = document) {
  if (typeof Element !== 'undefined' && selector instanceof Element) return selector;
  const raw = String(selector || '').trim();
  if (!raw) return null;
  const first = lookupEl(raw, root);
  if (first) return first;
  restampRefs(root);
  return lookupEl(raw, root);
}

function targetLabel(params = {}) {
  return params.selector || params.element || params.ref || params.target || 'target';
}

function isEditableTarget(target) {
  return Boolean(target?.isContentEditable || target?.getAttribute?.('contenteditable') === 'true' || target?.getAttribute?.('role') === 'textbox' && target?.tagName === 'DIV');
}

function dispatchInput(target, value) {
  const text = String(value ?? '');
  if (isEditableTarget(target)) {
    target.focus({ preventScroll: true });
    // React/ProseMirror/Twitter-style editors do not reliably observe a raw
    // textContent assignment. Use the browser editing command first, then
    // normalize the DOM and emit beforeinput/input/change for controlled state.
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
    } catch {}
    if (cleanText(target.innerText || target.textContent || '') !== cleanText(text)) {
      target.textContent = text;
    }
    try {
      target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } catch {
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  const proto =
    (target instanceof HTMLTextAreaElement && HTMLTextAreaElement.prototype) ||
    (target instanceof HTMLSelectElement && HTMLSelectElement.prototype) ||
    (target instanceof HTMLInputElement && HTMLInputElement.prototype) ||
    null;
  const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) {
    try { descriptor.set.call(target, text); } catch { target.value = text; }
  } else {
    target.value = text;
  }

  if (target.tagName === 'SELECT') {
    const option = Array.from(target.options || []).find((o) => o.value === text || cleanText(o.textContent) === text);
    if (option) target.value = option.value;
  }
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

function fireMouse(target, type, init = {}) {
  target.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    ...init
  }));
}

async function actionClick(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  await sleep(60);
  try { target.focus({ preventScroll: true }); } catch {}
  fireMouse(target, 'pointerdown', { button: 0 });
  fireMouse(target, 'mousedown', { button: 0 });
  fireMouse(target, 'mouseup', { button: 0 });
  fireMouse(target, 'click', { button: 0 });
  return { ok: true, value: `clicked ${selector}` };
}

async function actionSetValue(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  try { target.focus({ preventScroll: true }); } catch {}
  const wanted = String(p.value ?? p.text ?? '');
  dispatchInput(target, wanted);
  const entered = isEditableTarget(target) ? cleanText(target.innerText || target.textContent || '') : String(target.value ?? '');
  if (cleanText(entered) !== cleanText(wanted)) {
    return { ok: false, error: `Editor did not accept text for ${selector}` };
  }
  return { ok: true, value: `set ${selector}` };
}

async function actionType(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  try { target.focus({ preventScroll: true }); } catch {}
  const text = String(p.text ?? p.value ?? '');
  dispatchInput(target, text);
  return { ok: true, value: `typed into ${selector} (${text.length} chars)` };
}

function parseKeyChord(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split('+');
  const parts = raw.map((part) => String(part).trim()).filter(Boolean);
  const aliases = {
    esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab',
    space: ' ', backspace: 'Backspace', delete: 'Delete', arrowdown: 'ArrowDown',
    arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', option: 'Alt',
    cmd: 'Meta', command: 'Meta', meta: 'Meta'
  };
  return parts.map((part) => aliases[part.toLowerCase()] || part);
}

async function actionKey(p = {}) {
  const keys = parseKeyChord(p.keys ?? p.key ?? p.text);
  if (!keys.length) return { ok: false, error: 'press requires a key' };
  const target = document.activeElement || document.body;
  const modifiers = {
    ctrlKey: keys.includes('Control'),
    shiftKey: keys.includes('Shift'),
    altKey: keys.includes('Alt'),
    metaKey: keys.includes('Meta')
  };
  const primary = [...keys].reverse().find((key) => !['Control', 'Shift', 'Alt', 'Meta'].includes(key)) || keys[keys.length - 1];
  const opts = { key: primary, code: primary, bubbles: true, cancelable: true, composed: true, ...modifiers };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  if (primary.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
  await sleep(20);
  return { ok: true, value: `pressed ${keys.join('+')}` };
}

function actionScroll(p = {}) {
  const amount = Math.max(1, Number(p.amount) || 600);
  const direction = String(p.direction || 'down').toLowerCase();
  const target = p.selector || p.element || p.ref ? el(targetLabel(p)) : (document.scrollingElement || document.documentElement);
  if (!target) return { ok: false, error: `Scroll target not found: ${targetLabel(p)}` };

  if (p.y !== undefined) {
    target.scrollTo({ top: Number(p.y) || 0, behavior: p.smooth ? 'smooth' : 'auto' });
    return { ok: true, value: `scrolled to ${Number(p.y) || 0}` };
  }

  const axis = /left|right/.test(direction) ? 'left' : 'top';
  const sign = /up|left/.test(direction) ? -1 : 1;
  target.scrollBy({ [axis]: sign * amount, behavior: p.smooth ? 'smooth' : 'auto' });
  return { ok: true, value: `scrolled ${direction} ${amount}` };
}

function actionRead(p = {}) {
  const selector = p.selector || p.element || p.ref;
  const target = selector ? el(selector) : document.body;
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  let value = '';
  if (p.prop && target[p.prop] !== undefined) value = String(target[p.prop]);
  else if ('value' in target && target.value !== undefined) value = String(target.value);
  else value = cleanText(target.innerText || target.textContent || '');
  return { ok: true, value: value.slice(0, OUTPUT_LIMIT), truncated: value.length > OUTPUT_LIMIT };
}

function actionGrep(p = {}) {
  const pattern = String(p.pattern || p.query || p.text || '');
  if (!pattern) return { ok: false, error: 'grep requires pattern' };
  let regex;
  try {
    const flags = String(p.flags || 'i').replace(/[gy]/g, '') || 'i';
    regex = new RegExp(pattern, flags);
  } catch (e) {
    return { ok: false, error: `invalid pattern: ${e.message}` };
  }
  const source = p.over === 'interactive'
    ? Array.from(document.querySelectorAll('[data-hermes-ref]')).map((node) => {
        const ref = node.getAttribute('data-hermes-ref') || '';
        const text = cleanText(node.textContent || node.value || node.getAttribute('aria-label') || '');
        return `@${ref} ${text}`;
      }).join('\n')
    : String(document.body?.innerText || '');
  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
  const matches = source.split('\n').filter((line) => regex.test(line)).slice(0, limit);
  return { ok: true, value: matches.length ? matches.join('\n') : 'no matches', count: matches.length };
}

function actionFocus(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  target.focus({ preventScroll: true });
  return { ok: true, value: `focused ${selector}` };
}

async function actionSelectOption(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  if (!(target instanceof HTMLSelectElement)) return { ok: false, error: `${selector} is not a select element` };
  const wanted = String(p.value ?? p.option ?? p.text ?? '');
  const option = Array.from(target.options).find((o) => o.value === wanted || cleanText(o.textContent) === wanted);
  if (!option) return { ok: false, error: `Option not found: ${wanted}` };
  target.value = option.value;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: `selected ${cleanText(option.textContent) || option.value}` };
}

function actionGetImages(p = {}) {
  const limit = Math.min(Math.max(Number(p.limit) || 40, 1), 100);
  const images = Array.from(document.images || []).slice(0, limit).map((img, index) => ({
    index,
    src: img.currentSrc || img.src || '',
    alt: img.alt || '',
    width: img.naturalWidth || img.width || 0,
    height: img.naturalHeight || img.height || 0,
    ref: img.getAttribute('data-hermes-ref') ? `@${img.getAttribute('data-hermes-ref')}` : undefined
  }));
  return { ok: true, value: images, count: images.length };
}

function actionPageLinks(p = {}) {
  const limit = Math.min(Math.max(Number(p.limit) || 200, 1), 500);
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, limit).map((node, index) => ({
    index,
    text: cleanText(node.textContent || node.getAttribute('aria-label') || '').slice(0, 200),
    href: node.href || node.getAttribute('href') || '',
    ref: node.getAttribute('data-hermes-ref') ? `@${node.getAttribute('data-hermes-ref')}` : undefined
  }));
  return { ok: true, value: links, count: links.length };
}

function toMarkdown(root = document.body) {
  const lines = [];
  const walk = (node, depth) => {
    if (!node || node.nodeType !== 1 || lines.join('\n').length > OUTPUT_LIMIT) return;
    const tag = node.tagName;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(tag)) return;
    if (/^H[1-6]$/.test(tag)) {
      const text = cleanText(node.textContent);
      if (text) lines.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
      return;
    }
    if (tag === 'A' && node.href) {
      const text = cleanText(node.textContent) || node.href;
      lines.push(`[${text.slice(0, 180)}](${node.href})`);
      return;
    }
    if (tag === 'LI') {
      const text = cleanText(node.textContent).slice(0, 400);
      if (text) lines.push(`${'  '.repeat(Math.max(0, depth))} - ${text}`);
      return;
    }
    if (tag === 'PRE' || tag === 'CODE') {
      const text = String(node.textContent || '').slice(0, 2000);
      if (text.trim()) {
        lines.push('```');
        lines.push(text);
        lines.push('```');
      }
      return;
    }
    if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION') {
      const text = cleanText(node.textContent);
      if (text) lines.push(tag === 'BLOCKQUOTE' ? `> ${text}` : text);
      return;
    }
    for (const child of node.children || []) walk(child, depth + (tag === 'UL' || tag === 'OL' ? 1 : 0));
  };
  walk(root, 0);
  if (!lines.length) lines.push(cleanText(root?.innerText || '').slice(0, OUTPUT_LIMIT));
  return lines.join('\n').slice(0, OUTPUT_LIMIT);
}

function actionPageContent(p = {}) {
  const format = String(p.format || p.as || 'markdown').toLowerCase();
  if (format === 'html' || format === 'dom') return actionPageDom(p);
  if (format === 'links') return actionPageLinks(p);
  if (format === 'text') {
    const text = String(document.body?.innerText || '').slice(0, OUTPUT_LIMIT);
    return { ok: true, value: text, truncated: String(document.body?.innerText || '').length > OUTPUT_LIMIT };
  }
  const value = toMarkdown(document.body);
  return { ok: true, value, truncated: value.length >= OUTPUT_LIMIT };
}

function actionPageDom(p = {}) {
  const html = String(document.documentElement?.outerHTML || '').slice(0, OUTPUT_LIMIT);
  return {
    ok: true,
    value: html,
    truncated: String(document.documentElement?.outerHTML || '').length > OUTPUT_LIMIT
  };
}

function actionSearchDom(p = {}) {
  const selector = String(p.selector || p.css || '').trim();
  const text = String(p.text || p.query || p.pattern || '').trim();
  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
  let nodes = [];
  if (selector) {
    try { nodes = Array.from(document.querySelectorAll(selector)); }
    catch (e) { return { ok: false, error: `invalid selector: ${e.message}` }; }
  } else if (text) {
    const needle = text.toLowerCase();
    nodes = Array.from(document.querySelectorAll('a,button,h1,h2,h3,h4,p,li,label,td,th,span,div')).filter((node) => {
      return cleanText(node.textContent || '').toLowerCase().includes(needle);
    });
  } else {
    return { ok: false, error: 'search_dom requires selector or text' };
  }
  const value = nodes.slice(0, limit).map((node, index) => ({
    index,
    tag: node.tagName.toLowerCase(),
    ref: node.getAttribute('data-hermes-ref') ? `@${node.getAttribute('data-hermes-ref')}` : undefined,
    text: cleanText(node.textContent || node.value || '').slice(0, 240)
  }));
  return { ok: true, value, count: value.length };
}

function actionSnapshot() {
  restampRefs();
  const interactive = Array.from(document.querySelectorAll('[data-hermes-ref]')).slice(0, 250).map((node) => ({
    ref: `@${node.getAttribute('data-hermes-ref')}`,
    tag: node.tagName.toLowerCase(),
    role: node.getAttribute('role') || '',
    text: cleanText(node.textContent || node.value || node.getAttribute('aria-label') || '').slice(0, 300)
  }));
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map((node) => cleanText(node.textContent)).filter(Boolean).slice(0, 30);
  const links = actionPageLinks({ limit: 40 }).value;
  const text = String(document.body?.innerText || '').slice(0, OUTPUT_LIMIT);
  return {
    ok: true,
    value: { url: location.href, title: document.title, text, headings, links, interactive },
    truncated: String(document.body?.innerText || '').length > OUTPUT_LIMIT
  };
}

async function actionWait(p = {}) {
  const requestedMs = Number(p.ms ?? p.timeout ?? DEFAULT_WAIT_MS);
  const timeoutMs = Math.min(Math.max(Number.isFinite(requestedMs) ? requestedMs : DEFAULT_WAIT_MS, 1), MAX_WAIT_MS);
  const selector = p.selector || p.element || p.ref;
  const expectedText = String(p.text || '').trim();

  if (!selector && !expectedText) {
    await sleep(timeoutMs);
    return { ok: true, value: `waited ${timeoutMs}ms` };
  }

  const matches = () => {
    if (selector && !el(selector)) return false;
    if (expectedText && !String(document.body?.innerText || '').includes(expectedText)) return false;
    return true;
  };
  if (matches()) return { ok: true, value: selector ? `found ${selector}` : `found text: ${expectedText}` };

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(result);
    };
    const observer = new MutationObserver(() => {
      if (matches()) finish({ ok: true, value: selector ? `found ${selector}` : `found text: ${expectedText}` });
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const timer = setTimeout(() => finish({ ok: false, error: `wait timed out after ${timeoutMs}ms` }), timeoutMs);
  });
}

function actionNavigate(p = {}) {
  const raw = String(p.url || p.href || '').trim();
  if (!raw) return { ok: false, error: 'navigate requires url' };
  let url;
  try { url = new URL(raw, location.href); }
  catch { return { ok: false, error: 'navigate requires a valid URL' }; }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, error: 'Navigation requires a valid http(s) URL' };
  }
  location.assign(url.href);
  return { ok: true, value: `navigating to ${url.href}` };
}

function actionBack() {
  history.back();
  return { ok: true, value: 'navigating back' };
}

function actionForward() {
  history.forward();
  return { ok: true, value: 'navigating forward' };
}

function actionReload() {
  location.reload();
  return { ok: true, value: 'reloading page' };
}

// ---------------------------------------------------------------------------
// BrowserOS-parity actions (check/uncheck/clear/drag/_at coordinates/diff/eval)
// ---------------------------------------------------------------------------

/** Find the top element underneath viewport coordinates, else the ref. */
function elementAtPoint(x, y, fallbackSelector) {
  if (typeof x === 'number' && typeof y === 'number' && typeof document.elementFromPoint === 'function') {
    try {
      const at = document.elementFromPoint(x, y);
      if (at) return at;
    } catch {}
  }
  if (fallbackSelector) return el(fallbackSelector);
  return null;
}

async function actionCheck(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  if (!(target instanceof HTMLInputElement)) return { ok: false, error: `${selector} is not a checkbox/input element` };
  if (!target.checked) {
    fireMouse(target, 'pointerdown', { button: 0 });
    fireMouse(target, 'mousedown', { button: 0 });
    fireMouse(target, 'mouseup', { button: 0 });
    fireMouse(target, 'click', { button: 0 });
    target.checked = true;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { ok: true, value: `checked ${selector}` };
}

async function actionUncheck(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  if (!(target instanceof HTMLInputElement)) return { ok: false, error: `${selector} is not a checkbox/input element` };
  if (target.checked) {
    fireMouse(target, 'pointerdown', { button: 0 });
    fireMouse(target, 'mousedown', { button: 0 });
    fireMouse(target, 'mouseup', { button: 0 });
    fireMouse(target, 'click', { button: 0 });
    target.checked = false;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { ok: true, value: `unchecked ${selector}` };
}

async function actionClear(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  try { target.focus({ preventScroll: true }); } catch {}
  dispatchInput(target, '');
  if (target.isContentEditable) target.textContent = '';
  return { ok: true, value: `cleared ${selector}` };
}

/** Multi-field fill (BrowserOS fill fields[]). */
async function actionFillMany(p = {}) {
  const fields = Array.isArray(p.fields) ? p.fields : [];
  if (!fields.length) return { ok: false, error: 'fill requires fields[] (ref/value pairs)' };
  const results = [];
  for (const field of fields) {
    const selector = field.ref || field.selector || field.element;
    const target = selector ? el(selector) : null;
    if (!target) { results.push({ ref: selector, ok: false, error: 'not found' }); continue; }
    try { target.focus({ preventScroll: true }); } catch {}
    dispatchInput(target, field.value ?? field.text ?? '');
    results.push({ ref: selector, ok: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  return { ok: failed === 0, value: `filled ${results.length - failed}/${results.length} fields`, results };
}

/** BrowserOS click_at: coordinate-based click. */
async function actionClickAt(p = {}) {
  const target = elementAtPoint(p.x, p.y, p.selector || p.ref);
  if (!target) return { ok: false, error: 'No element at coordinates' };
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  await sleep(40);
  fireMouse(target, 'pointerdown', { button: p.button || 0, clientX: p.x, clientY: p.y });
  fireMouse(target, 'mousedown', { button: p.button || 0, clientX: p.x, clientY: p.y });
  fireMouse(target, 'mouseup', { button: p.button || 0, clientX: p.x, clientY: p.y });
  fireMouse(target, 'click', { button: p.button || 0, clientX: p.x, clientY: p.y });
  return { ok: true, value: `clicked at (${p.x},${p.y})` };
}

/** BrowserOS type_at / click then type at coordinates. */
async function actionTypeInto(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  try { target.focus({ preventScroll: true }); } catch {}
  const text = String(p.text ?? p.value ?? '');
  if (p.clear) dispatchInput(target, '');
  dispatchInput(target, text);
  return { ok: true, value: `typed into ${selector} (${text.length} chars)` };
}

/** BrowserOS hover_at: hover element under coordinates/ref. */
function actionHover(p = {}) {
  const selector = targetLabel(p);
  const target = (typeof p.x === 'number' && typeof p.y === 'number') ? elementAtPoint(p.x, p.y, selector) : el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  fireMouse(target, 'mouseover');
  fireMouse(target, 'mouseenter');
  fireMouse(target, 'mousemove');
  return { ok: true, value: `hovered ${p.x !== undefined ? `(${p.x},${p.y})` : selector}` };
}

/** BrowserOS drag: mouse drag between two refs. */
async function actionDrag(p = {}) {
  const from = el(p.ref || p.selector || p.from);
  const to = el(p.targetRef || p.to);
  if (!from || !to) return { ok: false, error: 'drag requires ref and targetRef' };
  from.scrollIntoView({ block: 'center', inline: 'nearest' });
  await sleep(30);
  const move = (node, type) => fireMouse(node, type, { button: 0, bubbles: true, cancelable: true, composed: true });
  move(from, 'pointerdown'); move(from, 'mousedown');
  move(from, 'mousemove'); move(to, 'mousemove');
  move(to, 'mouseup'); move(to, 'click');
  return { ok: true, value: `dragged ${p.ref} → ${p.targetRef}` };
}

/** BrowserOS diff-style: return a compact mutation summary since a baseline signature. */
function actionDiff(p = {}) {
  const base = p.baseline || p.key || '';
  const key = `${location.href}|${document.title}|${cleanText(String(document.body?.innerText || '')).slice(0, 400)}`;
  const changed = !base || base !== key;
  return { ok: true, value: { changed, url: location.href, title: document.title, key }, isChanged: changed };
}

async function actionHoldClick(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  const ms = Math.min(Math.max(Number(p.ms ?? p.duration ?? 800), 50), 8000);
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  await sleep(40);
  fireMouse(target, 'pointerdown', { button: 0 });
  fireMouse(target, 'mousedown', { button: 0 });
  await sleep(ms);
  fireMouse(target, 'mouseup', { button: 0 });
  fireMouse(target, 'click', { button: 0 });
  return { ok: true, value: `hold-clicked ${selector} (${ms}ms)` };
}

function actionNetwork(p = {}) {
  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
  const needle = String(p.query || p.filter || '').toLowerCase();
  const entries = (typeof performance !== 'undefined' && performance.getEntriesByType
    ? performance.getEntriesByType('resource')
    : []).filter((entry) => !needle || String(entry.name || '').toLowerCase().includes(needle));
  return {
    ok: true,
    count: entries.length,
    value: entries.slice(-limit).map((entry) => ({
      url: entry.name || '',
      type: entry.initiatorType || '',
      duration: Math.round(Number(entry.duration) || 0),
      size: Number(entry.transferSize) || 0
    }))
  };
}

function actionFind(p = {}) {
  const text = String(p.text || p.query || p.pattern || '').trim();
  if (!text) return { ok: false, error: 'find requires text' };
  return actionGrep({ pattern: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), limit: p.limit });
}

async function actionClipboard(p = {}) {
  const action = String(p.action || (p.text != null || p.value != null ? 'write' : 'read')).toLowerCase();
  if (action === 'write' || action === 'set' || action === 'copy') {
    const text = String(p.text ?? p.value ?? '');
    if (!navigator.clipboard?.writeText) return { ok: false, error: 'clipboard write is unavailable' };
    await navigator.clipboard.writeText(text);
    return { ok: true, value: `copied ${text.length} chars` };
  }
  if (!navigator.clipboard?.readText) return { ok: false, error: 'clipboard read is unavailable' };
  try {
    const text = await navigator.clipboard.readText();
    return { ok: true, value: String(text || '').slice(0, OUTPUT_LIMIT) };
  } catch (error) {
    return { ok: false, error: `clipboard read failed: ${error.message}` };
  }
}

function actionViewport() {
  const view = typeof window !== 'undefined' ? window : globalThis;
  return {
    ok: true,
    value: {
      innerWidth: Number(view.innerWidth) || 0,
      innerHeight: Number(view.innerHeight) || 0,
      devicePixelRatio: Number(view.devicePixelRatio) || 1
    }
  };
}

async function actionDblclick(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  await sleep(40);
  fireMouse(target, 'mousedown', { button: 0, detail: 1 });
  fireMouse(target, 'mouseup', { button: 0, detail: 1 });
  fireMouse(target, 'click', { button: 0, detail: 1 });
  fireMouse(target, 'mousedown', { button: 0, detail: 2 });
  fireMouse(target, 'mouseup', { button: 0, detail: 2 });
  fireMouse(target, 'dblclick', { button: 0, detail: 2 });
  return { ok: true, value: `double-clicked ${selector}` };
}

async function actionRightClick(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  await sleep(40);
  fireMouse(target, 'pointerdown', { button: 2 });
  fireMouse(target, 'mousedown', { button: 2 });
  fireMouse(target, 'mouseup', { button: 2 });
  fireMouse(target, 'contextmenu', { button: 2 });
  return { ok: true, value: `right-clicked ${selector}` };
}

function actionForms() {
  const forms = Array.from(document.forms || []).map((form, index) => ({
    index,
    id: form.id || '',
    name: form.getAttribute('name') || '',
    action: form.action || '',
    method: (form.method || 'get').toLowerCase(),
    fields: Array.from(form.elements || []).slice(0, 40).map((node) => ({
      tag: node.tagName.toLowerCase(),
      type: node.type || '',
      name: node.name || '',
      id: node.id || '',
      ref: node.getAttribute('data-hermes-ref') ? `@${node.getAttribute('data-hermes-ref')}` : undefined,
      value: node.type === 'password' ? '' : String(node.value || '').slice(0, 120)
    }))
  }));
  return { ok: true, value: forms, count: forms.length };
}

function actionTables(p = {}) {
  const limit = Math.min(Math.max(Number(p.limit) || 8, 1), 20);
  const tables = Array.from(document.querySelectorAll('table')).slice(0, limit).map((table, index) => {
    const rows = Array.from(table.querySelectorAll('tr')).slice(0, 30).map((row) => (
      Array.from(row.querySelectorAll('th,td')).slice(0, 16).map((cell) => cleanText(cell.textContent).slice(0, 120))
    ));
    return { index, caption: cleanText(table.caption?.textContent || '').slice(0, 160), rows };
  });
  return { ok: true, value: tables, count: tables.length };
}

function actionMeta() {
  const attr = (sel) => document.querySelector(sel)?.getAttribute('content') || document.querySelector(sel)?.getAttribute('href') || '';
  return {
    ok: true,
    value: {
      url: location.href,
      title: document.title,
      description: attr('meta[name="description"]') || attr('meta[property="og:description"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.href || '',
      ogTitle: attr('meta[property="og:title"]'),
      ogImage: attr('meta[property="og:image"]'),
      lang: document.documentElement.lang || ''
    }
  };
}

function actionSelection() {
  const text = cleanText(String(document.getSelection?.()?.toString() || ''));
  return { ok: true, value: text.slice(0, OUTPUT_LIMIT), empty: !text };
}

function actionHighlight(p = {}) {
  const needle = String(p.text || p.query || p.pattern || '').trim();
  if (!needle) return { ok: false, error: 'highlight requires text' };
  if (typeof window.find === 'function') {
    const found = window.find(needle, false, false, true);
    return { ok: true, value: found ? `highlighted ${needle}` : `no match for ${needle}`, found: !!found };
  }
  return actionFind({ text: needle });
}

function actionFrames() {
  const frames = Array.from(document.querySelectorAll('iframe,frame')).map((node, index) => ({
    index,
    src: node.src || '',
    name: node.name || '',
    title: node.title || '',
    ref: node.getAttribute('data-hermes-ref') ? `@${node.getAttribute('data-hermes-ref')}` : undefined
  }));
  return { ok: true, value: frames, count: frames.length };
}

function actionStorage(p = {}) {
  const which = String(p.store || p.area || 'local').toLowerCase().includes('session') ? 'sessionStorage' : 'localStorage';
  let store;
  try { store = which === 'sessionStorage' ? sessionStorage : localStorage; }
  catch (error) { return { ok: false, error: `${which} unavailable: ${error.message}` }; }
  const action = String(p.action || (p.key && p.value != null ? 'set' : p.key ? 'get' : 'list')).toLowerCase();
  if (action === 'list') {
    const keys = [];
    for (let i = 0; i < store.length && keys.length < 80; i++) keys.push(store.key(i));
    return { ok: true, value: keys.filter(Boolean), count: store.length };
  }
  if (!p.key) return { ok: false, error: 'storage get/set/remove requires key' };
  if (action === 'get') return { ok: true, value: store.getItem(String(p.key)) };
  if (action === 'set') {
    store.setItem(String(p.key), String(p.value ?? p.text ?? ''));
    return { ok: true, value: `set ${which}.${p.key}` };
  }
  if (action === 'remove' || action === 'delete') {
    store.removeItem(String(p.key));
    return { ok: true, value: `removed ${which}.${p.key}` };
  }
  return { ok: false, error: `Unknown storage action: ${action}` };
}

function actionAttrs(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  const wanted = Array.isArray(p.names) ? p.names : String(p.names || '').split(',').map((name) => name.trim()).filter(Boolean);
  const attrs = {};
  if (wanted.length) {
    for (const name of wanted) attrs[name] = target.getAttribute(name);
  } else {
    for (const node of target.attributes || []) attrs[node.name] = node.value;
  }
  return { ok: true, value: { tag: target.tagName.toLowerCase(), attrs } };
}

function actionCount(p = {}) {
  const selector = String(p.selector || p.css || '').trim();
  if (!selector) return { ok: false, error: 'count requires selector' };
  try { return { ok: true, value: document.querySelectorAll(selector).length, selector }; }
  catch (error) { return { ok: false, error: `invalid selector: ${error.message}` }; }
}

function actionScrollIntoView(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  target.scrollIntoView({ block: p.block || 'center', inline: 'nearest', behavior: p.smooth ? 'smooth' : 'auto' });
  return { ok: true, value: `scrolled ${selector} into view` };
}

function actionVisible(p = {}) {
  const selector = targetLabel(p);
  const target = el(selector);
  if (!target) return { ok: false, error: `Element not found: ${selector}` };
  const rect = target.getBoundingClientRect();
  const style = getComputedStyle(target);
  const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  return { ok: true, value: { visible, width: rect.width, height: rect.height } };
}

function actionCdpInfo() {
  return {
    ok: true,
    value: {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      frames: window.frames ? window.frames.length : 0,
      viewport: actionViewport().value,
      note: 'Companion CDP-lite page info. Full Chrome DevTools Protocol stays Hermes-native.'
    }
  };
}

/** BrowserOS evaluate: run a small read-only JS expression and return its JSON-safe result. */
function isMutatingEvaluate(expr) {
  if (/\b(eval|Function|import|require)\b/.test(expr)) return true;
  if (/(?:^|[^=!<>])=(?!=)/.test(expr)) return true;
  return /\b(assign|replace|reload|write|writeln|click|submit|remove|append|prepend|after|before|replaceWith|replaceChildren|setAttribute|removeAttribute|setItem|removeItem|open|close|focus|blur|select|dispatchEvent|insertAdjacentHTML|insertAdjacentElement|insertBefore|appendChild|removeChild|replaceChild)\s*\(/.test(expr);
}

function actionEvaluate(p = {}) {
  const expr = String(p.expression || p.script || p.js || '').trim();
  if (!expr) return { ok: false, error: 'evaluate requires expression' };
  if (isMutatingEvaluate(expr)) {
    return { ok: false, error: 'evaluate is read-only; use browser_click, browser_type, browser_fill, browser_press, browser_select, browser_check, or browser_run for page actions' };
  }
  try {
    const result = new Function('document', 'location', `return (${expr});`)(document, location);
    const value = (() => {
      try { return JSON.stringify(result, null, 0)?.slice(0, 20000); } catch { return String(result); }
    })();
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: `evaluate failed: ${e.message}` };
  }
}

/** Main dispatcher: run one action, return a normalized {ok, value|error}. */
async function runAction(action) {
  if (!action || typeof action !== 'object') return { ok: false, error: 'no action' };
  const name = String(action.name || action.action || '').replace(/^browser[:_-]?/, '').toLowerCase();
  const p = action.params || action.payload || action.args || action;
  try {
    switch (name) {
      case 'click': return await actionClick(p);
      case 'click_at': case 'clickat': return await actionClickAt(p);
      case 'fill': case 'input': case 'set_value': case 'setvalue': return await actionSetValue(p);
      case 'fill_many': case 'fillmany': return await actionFillMany(p);
      case 'type': return await actionType(p);
      case 'type_into': case 'type_into_input': case 'typeat': return await actionTypeInto(p);
      case 'key': case 'keys': case 'keypress': case 'press': return await actionKey(p);
      case 'scroll': return actionScroll(p);
      case 'read': case 'get_text': case 'extract': return actionRead(p);
      case 'grep': case 'search': return actionGrep(p);
      case 'focus': return actionFocus(p);
      case 'hover': case 'hover_at': return actionHover(p);
      case 'select': case 'select_option': case 'selectoption': return await actionSelectOption(p);
      case 'check': case 'checkbox': return await actionCheck(p);
      case 'uncheck': return await actionUncheck(p);
      case 'clear': case 'clear_input': return await actionClear(p);
      case 'drag': case 'drag_at': return await actionDrag(p);
      case 'diff': case 'changed': return actionDiff(p);
      case 'evaluate': case 'eval': case 'js': return actionEvaluate(p);
      case 'hold_click': case 'holdclick': case 'long_click': return await actionHoldClick(p);
      case 'dblclick': case 'double_click': case 'doubleclick': return await actionDblclick(p);
      case 'right_click': case 'rightclick': case 'contextmenu': return await actionRightClick(p);
      case 'forms': return actionForms();
      case 'tables': return actionTables(p);
      case 'meta': return actionMeta();
      case 'selection': return actionSelection();
      case 'highlight': return actionHighlight(p);
      case 'frames': case 'iframes': return actionFrames();
      case 'storage': return actionStorage(p);
      case 'attrs': case 'attributes': return actionAttrs(p);
      case 'count': return actionCount(p);
      case 'scroll_into_view': case 'scrollintoview': return actionScrollIntoView(p);
      case 'visible': case 'is_visible': return actionVisible(p);
      case 'network': return actionNetwork(p);
      case 'find': return actionFind(p);
      case 'clipboard': return await actionClipboard(p);
      case 'viewport': return actionViewport(p);
      case 'cdp_info': case 'cdp': return actionCdpInfo();
      case 'get_images': case 'images': return actionGetImages(p);
      case 'page_content': case 'pagecontent': case 'markdown': case 'get_page_content': return actionPageContent(p);
      case 'page_links': case 'links': case 'get_page_links': return actionPageLinks(p);
      case 'page_dom': case 'dom': case 'get_dom': case 'html': return actionPageDom(p);
      case 'search_dom': case 'searchdom': return actionSearchDom(p);
      case 'snapshot': return actionSnapshot();
      case 'wait': return await actionWait(p);
      case 'navigate': case 'goto': case 'open': return actionNavigate(p);
      case 'back': return actionBack();
      case 'forward': return actionForward();
      case 'reload': case 'refresh': return actionReload();
      default:
        if (!name || /snapshot|inspect|page/.test(name)) return actionSnapshot();
        return { ok: false, error: `Unknown action: ${name}` };
    }
  } catch (e) {
    return { ok: false, error: `${name} failed: ${e.message}` };
  }
}

/** Run a batch of actions sequentially, stopping on first failure by default. */
async function runActions(actions, opts = {}) {
  const results = [];
  for (const action of actions || []) {
    const result = await runAction(action);
    results.push(result);
    if (!result.ok && opts.stopOnError !== false) break;
  }
  return results;
}

if (typeof globalThis !== 'undefined' && !globalThis.__AGUI_PAGE_ACTOR_LOADED__) {
  globalThis.__AGUI_PAGE_ACTOR_LOADED__ = true;
  globalThis.HermesPageActor = {
    runAction,
    runActions,
    _el: el,
    _dispatchInput: dispatchInput,
    _refSelector: refSelector
  };
}