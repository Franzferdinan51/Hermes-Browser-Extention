/**
 * unit/page-test.mjs — Verifies the page-reader (DOM extraction) and
 * page-actor (DOM actions) modules against a jsdom fixture page.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(__dirname, '..', '..', 'extension');

const html = `<!doctype html>
<html lang="en">
<head><title>Test Page</title></head>
<body>
  <h1>Welcome to the test page</h1>
  <p>This is some paragraph text for the agent to read.</p>
  <nav>
    <a id="homeLink" href="/home">Home</a>
    <a href="/about">About Us</a>
  </nav>
  <form id="searchForm">
    <input id="q" name="q" placeholder="Search…" value="" />
    <button id="go" type="submit">Go</button>
  </form>
  <button class="cta" data-testid="buy">Buy Now</button>
  <select name="sel"><option value="a">A</option><option value="b">B</option></select>
  <textarea name="notes"></textarea>
  <img id="hero" src="https://example.com/hero.png" alt="Hero image" width="640" height="320" />
  <div style="display:none"><button>Hidden Button</button></div>
</body>
</html>`;

const dom = new JSDOM(html, { url: 'https://example.com/test-page', pretendToBeVisual: true });
const window = dom.window;
const document = window.document;

// ---- Build the module-visible sandbox. ----
const sandbox = {};
sandbox.window = window;
sandbox.document = document;
sandbox.location = window.location;
sandbox.history = window.history;
sandbox.innerHeight = 1000;
sandbox.innerWidth = 1000;
sandbox.navigator = window.navigator;
sandbox.getComputedStyle = (el) => {
  let node = el;
  while (node && node.nodeType === 1) {
    const inline = node.getAttribute ? node.getAttribute('style') : '';
    if (inline && /display\s*:\s*none/.test(inline)) return { display: 'none', visibility: 'visible', opacity: '1' };
    node = node.parentElement || null;
  }
  return { display: '', visibility: 'visible', opacity: '1' };
};
sandbox.MouseEvent = window.MouseEvent || function MouseEvent(type) { return new window.Event(type); };
sandbox.KeyboardEvent = window.KeyboardEvent || function KeyboardEvent(type) { return new window.Event(type); };
sandbox.InputEvent = window.InputEvent || window.Event;
sandbox.MutationObserver = window.MutationObserver;
sandbox.Element = window.Element;
sandbox.HTMLElement = window.HTMLElement;
sandbox.HTMLInputElement = window.HTMLInputElement;
sandbox.HTMLTextAreaElement = window.HTMLTextAreaElement;
sandbox.HTMLSelectElement = window.HTMLSelectElement;
sandbox.Event = window.Event;
sandbox.console = console;
sandbox.Date = Date;
sandbox.Math = Math;
sandbox.JSON = JSON;
sandbox.URL = URL;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.Promise = Promise;

// ---- jsdom gaps: polyfill browser conveniences the modules rely on ----
if (!('innerText' in window.HTMLElement.prototype)) {
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent || ''; }
  });
}
['scrollIntoView', 'focus', 'scrollTo', 'scrollBy'].forEach((method) => {
  if (typeof window.HTMLElement.prototype[method] !== 'function') window.HTMLElement.prototype[method] = function () {};
  if (typeof window.Element && window.Element !== window.HTMLElement && typeof window.Element.prototype[method] !== 'function') window.Element.prototype[method] = function () {};
  if (typeof window.HTMLDocument && typeof window.HTMLDocument.prototype[method] !== 'function') window.HTMLDocument.prototype[method] = function () {};
});

const origGBCR = window.HTMLElement.prototype.getBoundingClientRect;
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const base = origGBCR.call(this);
  const cs = window.getComputedStyle(this);
  if (cs.display === 'none') return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
  if (base.width === 0 && base.height === 0) return { width: 120, height: 24, top: 0, bottom: 24, left: 0, right: 120 };
  return base;
};
window.getComputedStyle = sandbox.getComputedStyle;

vm.createContext(sandbox);

function stripEsm(src) {
  return src
    .replace(/\bexport\s+\{\s*\}/g, '')
    .replace(/\bexport\s+async\s+function\s+/g, 'async function ')
    .replace(/\bexport\s+function\s+/g, 'function ')
    .replace(/\bexport\s+const\s+/g, 'const ')
    .replace(/\bexport\s+class\s+/g, 'class ');
}
function run(src) { vm.runInContext(stripEsm(src), sandbox, { timeout: 5000 }); }

try {
  run(fs.readFileSync(path.join(EXT, 'lib', 'page-reader.js'), 'utf8'));
  run(fs.readFileSync(path.join(EXT, 'lib', 'page-actor.js'), 'utf8'));
} catch (e) {
  console.error('Module load error:', e.message);
  process.exit(2);
}

const reader = sandbox.HermesPageReader;
const actor = sandbox.HermesPageActor;
if (!reader || !actor) {
  console.error('Modules did not register on the sandbox. reader:', !!reader, 'actor:', !!actor);
  process.exit(2);
}

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

// ---- Tests: page reader ----
const snap = reader.readPage();
ok(snap.url === 'https://example.com/test-page', 'readPage captures URL');
ok(snap.title === 'Test Page', 'readPage captures title');
ok(String(snap.summary.text).includes('Welcome to the test page'), 'readPage extracts body text');
ok(Array.isArray(snap.interactive) && snap.interactive.length >= 6, 'collectInteractive finds built-in controls (got ' + (snap.interactive || []).length + ')');
const link = snap.interactive.find((i) => i.href && i.href.includes('/about'));
ok(!!link && !!(link.selector || link.text), 'interactive map exposes a link with selector/text');
const btn = snap.interactive.find((i) => i.tag === 'button' && i.text.includes('Buy Now'));
ok(!!btn, 'interactive map exposes the Buy Now button');
const hidden = snap.interactive.find((i) => i.text.includes('Hidden Button'));
ok(!hidden, 'hidden element is excluded from interactive map');
ok(typeof snap.dom === 'string' && snap.dom.length > 0, 'buildDomText produces a DOM string');
const refButton = snap.interactive.find((i) => i.text.includes('Buy Now'));
ok(/^e\d+$/.test(refButton?.ref || '') && String(snap.accessibility).includes(`[${refButton.ref}]`), 'accessibility snapshot exposes stable element refs');

// ---- Tests: page actor ----
async function drive() {
  const clickRes = await actor.runAction({ name: 'click', params: { selector: 'Buy Now' } });
  ok(clickRes.ok, 'actor clicks button by text fallback');

  const refClick = await actor.runAction({ name: 'click', params: { selector: refButton.ref } });
  ok(refClick.ok, 'actor clicks eN ref');

  const hermesRefClick = await actor.runAction({ name: 'click', params: { selector: `@${refButton.ref}` } });
  ok(hermesRefClick.ok, 'actor clicks Hermes-style @eN ref');

  const grepRes = await actor.runAction({ name: 'grep', params: { pattern: 'paragraph text' } });
  ok(grepRes.ok && grepRes.count >= 1 && String(grepRes.value).includes('paragraph text'), 'actor greps visible page content');

  const fillRes = await actor.runAction({ name: 'fill', params: { selector: '#q', value: 'hello world' } });
  ok(fillRes.ok && document.getElementById('q').value === 'hello world', 'actor fills input by id selector');

  const selRes = await actor.runAction({ name: 'select_option', params: { selector: 'select[name="sel"]', value: 'b' } });
  ok(selRes.ok && document.querySelector('select[name="sel"]').value === 'b', 'actor selects dropdown option');

  const hoverRes = await actor.runAction({ name: 'hover', params: { selector: `@${refButton.ref}` } });
  ok(hoverRes.ok, 'actor hovers Hermes ref');

  const waitRes = await actor.runAction({ name: 'wait', params: { selector: '#go', ms: 50 } });
  ok(waitRes.ok, 'actor wait resolves immediately for existing selector');

  const imagesRes = await actor.runAction({ name: 'get_images', params: {} });
  ok(imagesRes.ok && imagesRes.count >= 1 && imagesRes.value.some((img) => img.alt === 'Hero image'), 'actor returns page image metadata');

  const readRes = await actor.runAction({ name: 'read', params: { selector: 'h1' } });
  ok(readRes.ok && String(readRes.value).includes('Welcome'), 'actor reads element text');

  const missing = await actor.runAction({ name: 'click', params: { selector: '#does-not-exist' } });
  ok(!missing.ok, 'actor returns error for missing element');

  const batch = await actor.runActions([
    { name: 'read', params: { selector: 'body' } },
    { name: 'read', params: { selector: 'h1' } }
  ]);
  ok(Array.isArray(batch) && batch.length === 2 && batch.every((r) => r.ok), 'runActions executes a batch');
}
await drive().catch((e) => { console.error('drive error', e.message); failed++; });

console.log('\n[' + passed + ' passed, ' + failed + ' failed]');
process.exit(failed ? 1 : 0);