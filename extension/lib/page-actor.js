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

function refSelector(value) {
  const match = String(value || '').trim().match(/^@?(e\d+)$/i);
  return match ? `[data-hermes-ref="${match[1]}"]` : '';
}

function el(selector, root = document) {
  if (typeof Element !== 'undefined' && selector instanceof Element) return selector;
  const raw = String(selector || '').trim();
  if (!raw) return null;

  const ref = refSelector(raw);
  if (ref) {
    const byRef = root.querySelector(ref);
    if (byRef) return byRef;
  }

  try {
    const found = root.querySelector(raw);
    if (found) return found;
  } catch {}

  const needle = raw.toLowerCase();
  const candidates = Array.from(root.querySelectorAll(
    'button,a,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]'
  ));
  return candidates.find((node) => {
    const text = cleanText(node.textContent || node.value || node.getAttribute('aria-label') || node.getAttribute('title'));
    return text.toLowerCase() === needle;
  }) || null;
}

function targetLabel(params = {}) {
  return params.selector || params.element || params.ref || params.target || 'target';
}

function dispatchInput(target, value) {
  const text = String(value ?? '');
  if (target.isContentEditable) {
    target.textContent = text;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
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
  dispatchInput(target, p.value ?? p.text ?? '');
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

function actionSnapshot() {
  const interactive = Array.from(document.querySelectorAll('[data-hermes-ref]')).slice(0, 250).map((node) => ({
    ref: `@${node.getAttribute('data-hermes-ref')}`,
    tag: node.tagName.toLowerCase(),
    role: node.getAttribute('role') || '',
    text: cleanText(node.textContent || node.value || node.getAttribute('aria-label') || '').slice(0, 300)
  }));
  const text = String(document.body?.innerText || '').slice(0, OUTPUT_LIMIT);
  return {
    ok: true,
    value: { url: location.href, title: document.title, text, interactive },
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
  const url = String(p.url || p.href || '').trim();
  if (!url) return { ok: false, error: 'navigate requires url' };
  location.assign(url);
  return { ok: true, value: `navigating to ${url}` };
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

/** BrowserOS evaluate: run a small read-only JS expression and return its JSON-safe result. */
function actionEvaluate(p = {}) {
  const expr = String(p.expression || p.script || p.js || '').trim();
  if (!expr) return { ok: false, error: 'evaluate requires expression' };
  try {
    const result = new Function(`with(document){return (${expr});}`)();
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
      case 'get_images': case 'images': return actionGetImages(p);
      case 'snapshot': return actionSnapshot();
      case 'wait': return await actionWait(p);
      case 'navigate': case 'goto': case 'open': return actionNavigate(p);
      case 'back': return actionBack();
      case 'forward': return actionForward();
      case 'reload': case 'refresh': return actionReload();
      default: return { ok: false, error: `Unknown action: ${name}` };
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