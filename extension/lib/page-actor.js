/**
 * PageActor — executes DOM actions on behalf of the agent. Hermes emits a
 * tool call (e.g. { name: "browser_click", args: {...} }) and the bridge / SW
 * forward a normalized action here. This module runs in the content-script
 * (page) context so it can touch the real DOM.
 *
 * Supported actions (action.name):
 *   click       {selector}
 *   fill        {selector, value}
 *   type        {selector, text}           (progressive; dispatches input events)
 *   key         {keys}                     (dispatch keyboard events on document.activeElement)
 *   scroll      {selector?, direction?, amount?} | {y?}
 *   navigate    {url}                      (location.href = url — handled by SW typically)
 *   focus       {selector}
 *   read        {selector?}                (return text/value of element or whole page)
 *   wait        {ms}
 *   extract     {selector, prop?}
 *   set_value   {selector, value}          (set .value + dispatch input/change)
 *
 * Returns a result object {ok, value?, error?}.
 */

const BASE_SELECTOR_LIMIT = 50;

function el(selector, root = document) {
  if (selector instanceof Element) return selector;
  try {
    const found = root.querySelector(selector);
    if (found) return found;
  } catch {}
  // Fallback: try by text match for buttons/links if a selector looks like text
  const needle = String(selector).toLowerCase();
  const byText = Array.from(root.querySelectorAll('button,a,[role="button"]'))
    .find((e) => String(e.textContent || '').trim().toLowerCase() === needle);
  return byText || null;
}

function dispatchInput(target, value) {
  // Pick the correct value setter based on the element type so set_value works
  // on inputs, textareas, AND selects without throwing.
  const proto =
    (target instanceof HTMLTextAreaElement && HTMLTextAreaElement.prototype) ||
    (target instanceof HTMLSelectElement && HTMLSelectElement.prototype) ||
    (target instanceof HTMLInputElement && HTMLInputElement.prototype) ||
    null;
  let setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) {
    try { setter.set.call(target, value); } catch { target.value = value; }
  } else {
    target.value = value;
  }
  if (target.tagName === 'SELECT') {
    const val = String(value ?? '');
    const opt = Array.from(target.options || []).find((o) => o.value === val || o.text === val);
    if (opt) target.value = opt.value;
  }
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

function fire(target, type, init = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init });
  target.dispatchEvent(ev);
}

async function actionClick(p) {
  const target = el(p.selector || p.element);
  if (!target) return { ok: false, error: `Element not found: ${p.selector}` };
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(120);
  target.focus({ preventScroll: true });
  fire(target, 'mousedown', { button: 0 });
  fire(target, 'mouseup', { button: 0 });
  fire(target, 'click', { button: 0 });
  return { ok: true, value: `clicked ${p.selector}` };
}

async function actionFill(p) {
  const target = el(p.selector || p.element);
  if (!target) return { ok: false, error: `Element not found: ${p.selector}` };
  target.focus({ preventScroll: true });
  dispatchInput(target, String(p.value ?? ''));
  if (target.tagName === 'SELECT') {
    // best-effort select option
    const val = String(p.value ?? '');
    const opt = Array.from(target.options).find((o) => o.value === val || o.text === val);
    if (opt) {
      target.value = opt.value;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  return { ok: true, value: `filled ${p.selector}` };
}

async function actionType(p) {
  const target = el(p.selector || p.element);
  if (!target) return { ok: false, error: `Element not found: ${p.selector}` };
  target.focus({ preventScroll: true });
  const text = String(p.text ?? '');
  // Type char-by-char with tiny gaps so frameworks catch it; fallback to set_value
  await sleep(50);
  dispatchInput(target, text);
  return { ok: true, value: `typed into ${p.selector || 'focused'} (${text.length} chars)` };
}

async function actionKey(p) {
  const keys = Array.isArray(p.keys) ? p.keys : String(p.keys || '').split('+').map((k) => k.trim());
  const target = document.activeElement || document.body;
  const keyMap = { enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', arrowdown: 'ArrowDown', arrowup: 'ArrowUp', backspace: 'Backspace', delete: 'Delete', control: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta' };
  for (const k of keys) {
    const key = keyMap[k.toLowerCase()] || k;
    const isMod = /^(Control|Shift|Alt|Meta|Cmd)$/.test(key);
    const mods = { ctrlKey: keys.includes('Control') || keys.includes('control'), shiftKey: keys.includes('Shift') || keys.includes('shift'), altKey: keys.includes('Alt') || keys.includes('alt'), metaKey: keys.includes('Meta') || keys.includes('Cmd') || keys.includes('cmd') };
    const evOpts = { key, code: key, bubbles: true, cancelable: true, ...mods };
    target.dispatchEvent(new KeyboardEvent('keydown', evOpts));
    if (!isMod && key.length === 1) { target.dispatchEvent(new KeyboardEvent('keypress', evOpts)); }
    else if (!isMod) { target.dispatchEvent(new KeyboardEvent('keyup', evOpts)); }
    await sleep(40);
  }
  return { ok: true, value: `sent keys ${keys.join('+')}` };
}

function actionScroll(p) {
  if (p.y !== undefined || p.selector) {
    const t = p.selector ? el(p.selector) : document.scrollingElement;
    if (!t) return { ok: false, error: 'scroll target missing' };
    if (p.y !== undefined) t.scrollTo({ top: p.y, behavior: p.smooth ? 'smooth' : 'auto' });
    else {
      const dir = p.direction || 'down';
      const amt = p.amount ?? 500;
      const delta = dir === 'up' ? -amt : amt;
      t.scrollBy({ top: delta, behavior: p.smooth ? 'smooth' : 'auto' });
    }
    return { ok: true, value: `scrolled ${p.direction || p.y}` };
  }
  window.scrollBy({ top: (p.direction === 'up' ? -(p.amount ?? 500) : (p.amount ?? 500)), behavior: p.smooth ? 'smooth' : 'auto' });
  return { ok: true };
}

function actionRead(p) {
  const target = p.selector ? el(p.selector) : document;
  if (!target) return { ok: false, error: `Element not found: ${p.selector}` };
  let value = '';
  if (p.prop && target[p.prop] !== undefined) value = String(target[p.prop]);
  else if (target.value !== undefined) value = String(target.value);
  else value = cleanText(target.innerText || target.textContent || '');
  return { ok: true, value: value.slice(0, 25000) };
}

function actionFocus(p) {
  const target = el(p.selector);
  if (!target) return { ok: false, error: `Element not found: ${p.selector}` };
  target.focus({ preventScroll: true });
  return { ok: true, value: 'focused' };
}

function actionWait(p) {
  return sleep(p.ms ?? 1000).then(() => ({ ok: true, value: `waited ${p.ms ?? 1000}ms` }));
}

function actionExtract(p) {
  const target = el(p.selector || 'body');
  if (!target) return { ok: false, error: `Element not found: ${p.selector}` };
  if (p.prop !== undefined) return { ok: true, value: target[p.prop] };
  return { ok: true, value: cleanText(target.innerText || target.textContent || '') };
}

function actionSetValue(p) {
  const target = el(p.selector);
  if (!target) return { ok: false, error: `Element not found: ${p.selector}` };
  dispatchInput(target, String(p.value ?? ''));
  return { ok: true, value: 'set value' };
}

function cleanText(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Main dispatcher: run one action, return a normalized {ok, value|error}. */
async function runAction(action) {
  if (!action || typeof action !== 'object') return { ok: false, error: 'no action' };
  const name = String(action.name || action.action || '').replace(/^browser[:_-]?/, '');
  const p = action.params || action.payload || action.args || action;
  try {
    switch (name) {
      case 'click': return await actionClick(p);
      case 'fill': case 'input': case 'set_value': case 'setvalue': return await actionSetValue(p);
      case 'type': return await actionType(p);
      case 'key': case 'keys': case 'keypress': return await actionKey(p);
      case 'scroll': return actionScroll(p);
      case 'read': case 'get_text': case 'extract': return actionRead(p);
      case 'focus': return actionFocus(p);
      case 'wait': return await actionWait(p);
      default: return { ok: false, error: `Unknown action: ${name}` };
    }
  } catch (e) {
    return { ok: false, error: `${name} failed: ${e.message}` };
  }
}

/** Run a batch of actions sequentially, stopping on first failure if `stopOnError`. */
async function runActions(actions, opts = {}) {
  const results = [];
  for (const a of actions || []) {
    const r = await runAction(a);
    results.push(r);
    if (!r.ok && opts.stopOnError !== false) break;
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
    _cssPath: () => null
  };
}