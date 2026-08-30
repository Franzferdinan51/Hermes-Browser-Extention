import test from 'node:test';
import assert from 'node:assert/strict';
import { openHermesFullView } from '../extension/lib/fulltab-opener.mjs';

test('full-tab opener prefers a verified active Chrome tab', async () => {
  const calls = [];
  const result = await openHermesFullView({
    url: 'chrome-extension://test/app.html?sessionId=one',
    tabsApi: { create: async (options) => { calls.push(options); return { id: 42 }; } },
    runtimeApi: { sendMessage: async () => { throw new Error('must not run'); } },
  });
  assert.deepEqual(calls, [{ url: 'chrome-extension://test/app.html?sessionId=one', active: true }]);
  assert.deepEqual(result, { ok: true, method: 'tabs', tabId: 42 });
});

test('full-tab opener falls back to the background worker when direct tab creation fails', async () => {
  const result = await openHermesFullView({
    url: 'chrome-extension://test/app.html',
    tabsApi: { create: async () => { throw new Error('tabs unavailable'); } },
    runtimeApi: { sendMessage: async (message) => ({ ok: message.type === 'HERMES_OPEN_FULL_VIEW' }) },
  });
  assert.deepEqual(result, { ok: true, method: 'background' });
});

test('full-tab opener uses window.open as a final fallback and reports total failure', async () => {
  const opened = [];
  const result = await openHermesFullView({
    url: 'chrome-extension://test/app.html',
    tabsApi: { create: async () => ({}) },
    runtimeApi: { sendMessage: async () => ({ ok: false, reason: 'worker asleep' }) },
    windowOpen: (...args) => { opened.push(args); return {}; },
  });
  assert.equal(result.method, 'window');
  assert.equal(opened.length, 1);

  await assert.rejects(() => openHermesFullView({
    url: 'chrome-extension://test/app.html',
    tabsApi: { create: async () => ({}) },
    runtimeApi: { sendMessage: async () => ({ ok: false }) },
    windowOpen: () => null,
  }), /Could not open Hermes Web/);
});
