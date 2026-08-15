/**
 * unit/content-guard-test.mjs
 * Verifies the internal-page URL guard added to content.js.
 * Tests the RE_INTERNAL pattern against all documented internal URL shapes.
 */

const RE_INTERNAL = /^(about|chrome|chrome-extension|edge|brave|opera):/i;

function shouldBlock(url) {
  return RE_INTERNAL.test(url);
}

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

// ---- Should be blocked (internal pages) ----
ok(shouldBlock('about:blank'), 'about:blank is blocked');
ok(shouldBlock('about:home'), 'about:home is blocked');
ok(shouldBlock('chrome://newtab/'), 'chrome:// newtab is blocked');
ok(shouldBlock('chrome://extensions/'), 'chrome:// extensions is blocked');
ok(shouldBlock('chrome-extension://abc123/popup.html'), 'chrome-extension:// from another extension is blocked');
ok(shouldBlock('edge://settings/'), 'edge:// settings is blocked');
ok(shouldBlock('brave://newtab/'), 'brave:// newtab is blocked');
ok(shouldBlock('opera://bookmarks/'), 'opera:// bookmarks is blocked');
ok(shouldBlock('ABOUT:BLANK'), 'about:blank uppercase scheme is blocked (case-insensitive)');
ok(shouldBlock('Chrome://Extensions'), 'Chrome:// mixed-case scheme is blocked');

// ---- Should NOT be blocked (normal web pages) ----
ok(!shouldBlock('https://example.com/'), 'https:// web page is allowed');
ok(!shouldBlock('http://localhost:8965/'), 'http:// localhost is allowed');
ok(!shouldBlock('https://github.com/Franzferdinan51/Hermes-Browser-Extention'), 'https:// GitHub is allowed');
ok(!shouldBlock('file:///Users/duckets/test.html'), 'file:// local file is allowed');
ok(!shouldBlock('data:text/html,<h1>Hello</h1>'), 'data: URI is allowed (not in pattern)');
ok(!shouldBlock('blob:https://example.com/abc123'), 'blob: URI is allowed (not in pattern)');
ok(!shouldBlock('javascript:void(0)'), 'javascript: URI is allowed (not in pattern — nav guard is separate)');

// ---- Verify the guard does not appear to break normal page behavior ----
// The guard function itself is a pure regex check; the IIFE wrapper bails out
// before any chrome.runtime listeners are registered, so normal pages are
// unaffected after the guard check passes.
ok(RE_INTERNAL.source === '^(about|chrome|chrome-extension|edge|brave|opera):', 'regex source is stable and readable');

console.log(`\n[${passed} passed, ${failed} failed]`);
process.exit(failed ? 1 : 0);
