import assert from 'node:assert/strict';
import { runChromeTool } from '../../extension/lib/browser-chrome.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function makeTab(overrides = {}) {
  return {
    id: 42,
    windowId: 7,
    index: 0,
    active: true,
    pinned: false,
    highlighted: true,
    mutedInfo: { muted: false },
    discarded: false,
    groupId: -1,
    title: 'Example',
    url: 'https://example.com/',
    status: 'complete',
    ...overrides
  };
}

await test('tabs active queries the current active tab instead of requiring an id', async () => {
  let getCalled = false;
  let queryArgs = null;
  globalThis.chrome = {
    tabs: {
      get: async () => {
        getCalled = true;
        throw new Error('tabs.get should not be used for active-tab lookup');
      },
      query: async (query) => {
        queryArgs = query;
        return [makeTab()];
      }
    },
    windows: {}
  };

  const result = await runChromeTool('tabs', { action: 'active' }, null);
  assert.equal(result.ok, true);
  assert.equal(result.value.id, 42);
  assert.deepEqual(queryArgs, { active: true, currentWindow: true });
  assert.equal(getCalled, false);
});

await test('cookies reject an invalid explicit URL instead of falling back to the current tab', async () => {
  let getAllCalled = false;
  globalThis.chrome = {
    tabs: {
      get: async () => makeTab()
    },
    cookies: {
      getAll: async () => {
        getAllCalled = true;
        return [];
      }
    }
  };

  const result = await runChromeTool('cookies', {
    action: 'list',
    url: 'javascript:alert(1)'
  }, 42);

  assert.equal(result.ok, false);
  assert.match(result.error, /http\(s\)|valid.*url|url.*valid/i);
  assert.equal(getAllCalled, false);
});

await test('bookmark update rejects non-http URLs instead of passing them to Chrome', async () => {
  let updateCalled = false;
  globalThis.chrome = {
    bookmarks: {
      update: async () => {
        updateCalled = true;
        return {};
      }
    }
  };

  const result = await runChromeTool('bookmarks', {
    action: 'update',
    id: '123',
    url: 'javascript:alert(1)'
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /http\(s\)|bookmark.*url/i);
  assert.equal(updateCalled, false);
});

console.log(`\nBrowser Chrome tools: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
