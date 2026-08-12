/**
 * background.js — Manifest V3 service worker.
 *
 * Owns configuration, AG-UI, the authenticated bridge WebSocket, page context,
 * browser-tool execution, Hermes runtime discovery, and UI event relaying.
 */

import { AGUIClient } from './agui-client.js';
import { runChromeTool } from './browser-chrome.js';
import { readThreadId } from './thread.js';

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:8965',
  authToken: '',
  model: 'qwen3.5-9b',
  modelProvider: 'lmstudio',
  workspace: '',
  autoSnapshot: false,
  attachPageContext: true,
  maxDomChars: 30000,
  enablePageActing: true,
  theme: 'midnight',
  density: 'comfortable',
  accentGlow: true
};

const store = {
  async get() { return (await chrome.storage.local.get(DEFAULTS)) || DEFAULTS; },
  async set(patch) { await chrome.storage.local.set(patch); }
};

const relay = new EventTarget();
function emit(type, payload) { relay.dispatchEvent(new CustomEvent(type, { detail: payload })); }

let client = null;
let currentThreadId = null;
let lastSnapshot = null;
let lastRuntime = null;
let ownedTabId = null;

function isRestrictedUrl(url = '') {
  return /^(chrome|edge|brave|opera|about|devtools|chrome-extension|moz-extension):/i.test(String(url || ''));
}

function pinOwnedTab(tab) {
  if (tab?.id == null) return;
  ownedTabId = tab.id;
  try {
    chrome.storage?.session?.set({
      hermesOwnedTabId: tab.id,
      hermesOwnedTabUrl: tab.url || '',
      hermesOwnedTabTitle: tab.title || ''
    });
  } catch {}
}

function clearOwnedTab() {
  ownedTabId = null;
  try { chrome.storage?.session?.remove(['hermesOwnedTabId', 'hermesOwnedTabUrl', 'hermesOwnedTabTitle']); } catch {}
}

async function getPageTab(preferredId, opts = {}) {
  const tryId = preferredId != null ? preferredId : ownedTabId;
  if (tryId != null) {
    const tab = await chrome.tabs.get(tryId).catch(() => null);
    if (tab?.id != null && !isRestrictedUrl(tab.url)) return tab;
    if (opts.pinned) return null;
  }
  if (opts.pinned) return null;
  const queries = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true }
  ];
  for (const query of queries) {
    const [tab] = await chrome.tabs.query(query).catch(() => []);
    if (tab?.id != null && !isRestrictedUrl(tab.url)) return tab;
  }
  const httpTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  return httpTabs.find((tab) => tab.active) || httpTabs[0] || null;
}

function persistThreadId(id) {
  const threadId = String(id || '').trim();
  if (!threadId) return;
  currentThreadId = threadId;
  try { chrome.storage?.session?.set({ hermesThreadId: threadId }); } catch {}
}

async function restoreThreadId() {
  try {
    const stored = await chrome.storage?.session?.get(['hermesThreadId', 'hermesOwnedTabId']);
    if (stored?.hermesThreadId) currentThreadId = String(stored.hermesThreadId);
    if (stored?.hermesOwnedTabId != null) ownedTabId = Number(stored.hermesOwnedTabId);
  } catch {}
}
restoreThreadId();

function bridgeHeaders(cfg) {
  return cfg.authToken ? { Authorization: `Bearer ${cfg.authToken}` } : {};
}

async function bridgeJson(path) {
  const cfg = await store.get();
  const url = `${cfg.bridgeUrl.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, { headers: bridgeHeaders(cfg) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const detail = data?.error?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return data;
}

async function buildClient() {
  const cfg = await store.get();
  if (client) client.removeAll();
  client = new AGUIClient({
    url: `${cfg.bridgeUrl.replace(/\/$/, '')}/agent`,
    headers: bridgeHeaders(cfg),
    onEvent: (evt) => {
      emit('agui-event', evt);
      handleEvent(evt);
    }
  });
  client.agentId = 'hermes';
  return client;
}

async function handleEvent(evt) {
  try {
    if (evt.type === 'RUN_STARTED') {
      const threadId = readThreadId(evt);
      if (threadId) persistThreadId(threadId);
      emit('agent-state', { phase: 'running' });
    } else if (evt.type === 'RUN_FINISHED') emit('agent-state', { phase: 'done' });
    else if (evt.type === 'RUN_ERROR') emit('agent-state', { phase: 'error' });
  } catch (e) {
    console.error('[Hermes] handleEvent', e);
  }
}

// ---------------------------------------------------------------------------
// Bridge WebSocket
// ---------------------------------------------------------------------------
let bridgeWs = null;
let bridgeReconnectTimer = null;
let bridgeConnecting = false;

async function wsBridgeUrl() {
  const cfg = await store.get();
  const base = cfg.bridgeUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const url = new URL(`${base}/ws`);
  if (cfg.authToken) url.searchParams.set('token', cfg.authToken);
  return url.href;
}

function scheduleBridgeReconnect() {
  if (bridgeReconnectTimer) return;
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = null;
    connectBridgeWs();
  }, 3000);
}

function connectBridgeWs() {
  try {
    if (bridgeConnecting) return;
    if (bridgeWs && (bridgeWs.readyState === WebSocket.CONNECTING || bridgeWs.readyState === WebSocket.OPEN)) return;
  } catch {
    bridgeWs = null;
  }

  bridgeConnecting = true;
  wsBridgeUrl().then((url) => {
    try { bridgeWs = new WebSocket(url); }
    catch {
      bridgeConnecting = false;
      scheduleBridgeReconnect();
      return;
    }

    bridgeWs.onopen = () => {
      bridgeConnecting = false;
      console.log('[Hermes] bridge WS open');
      emit('bridge-status', { connected: true });
    };

    bridgeWs.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.kind !== 'browser-action') return;

      const preferredId = msg.tabId ?? msg.action?.params?.tabId ?? ownedTabId;
      const pinned = preferredId != null;
      let tab = null;
      try { tab = await getPageTab(preferredId, { pinned }); } catch {}
      let result = { ok: false, error: 'no attached page tab' };
      if (tab?.id != null) {
        pinOwnedTab(tab);
        result = await runActionOnTab(msg.action, tab.id);
      }

      if (bridgeWs?.readyState === WebSocket.OPEN) {
        bridgeWs.send(JSON.stringify({
          kind: 'browser-result',
          requestId: msg.requestId,
          toolCallId: msg.toolCallId,
          result
        }));
      }
    };

    bridgeWs.onclose = () => {
      bridgeConnecting = false;
      bridgeWs = null;
      emit('bridge-status', { connected: false });
      scheduleBridgeReconnect();
    };
    bridgeWs.onerror = () => {
      try { bridgeWs.close(); } catch {}
    };
  }).catch(() => {
    bridgeConnecting = false;
    scheduleBridgeReconnect();
  });
}
connectBridgeWs();

async function getActiveTab() {
  return getPageTab();
}

// ---------------------------------------------------------------------------
// Page context and browser actions
// ---------------------------------------------------------------------------
async function snapshotTab(tabId, opts = {}) {
  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : await getPageTab(undefined, { pinned: opts.fresh ? false : ownedTabId != null });
  if (!tab?.id) throw new Error('No tab');
  if (isRestrictedUrl(tab.url)) throw new Error('Cannot attach a restricted browser page');
  pinOwnedTab(tab);

  // Primary: try the pre-declared content script (isolated world).
  let resp = await chrome.tabs.sendMessage(tab.id, { kind: 'read-page' }).catch(() => null);

  // Fallback 1: force-inject the libraries into the page and retry.
  if (!resp?.ok) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['lib/page-reader.js', 'lib/page-actor.js', 'lib/content.js']
    }).catch(() => {});
    resp = await chrome.tabs.sendMessage(tab.id, { kind: 'read-page' }).catch(() => null);
  }

  // Fallback 2: self-contained capture straight in the MAIN world. This works
  // even for pages where content scripts did not inject (activeTab grants the
  // scripting host access after the user opens the panel), avoiding reliance
  // on a pre-declared isolated-world listener.
  if (!resp?.ok) {
    resp = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: capturePageInline
    }).then((results) => results?.[0]?.result || null).catch(() => null);
  }

  if (resp?.ok && resp.snapshot) {
    lastSnapshot = { tabId: tab.id, url: tab.url, title: tab.title, snapshot: resp.snapshot };
    emit('page-snapshot', lastSnapshot);
    return lastSnapshot;
  }
  if (resp?.url && resp.title) {
    // Used for the inline MAIN-world fallback above.
    lastSnapshot = { tabId: tab.id, url: tab.url, title: tab.title, snapshot: resp };
    emit('page-snapshot', lastSnapshot);
    return lastSnapshot;
  }
  return null;
}

/** Runs in the page (MAIN world) via executeScript when content scripts are absent. */
function capturePageInline() {
  try {
    const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && +(cs.opacity || '1') !== 0;
    };
    const visible = (sel, max = 800) => Array.from(document.querySelectorAll(sel)).filter(isVisible).slice(0, max);
    const interactive = visible('a,button,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]').map((node, i) => {
      const ref = `e${i + 1}`;
      try { node.setAttribute('data-hermes-ref', ref); } catch {}
      let sel = '';
      try {
        const parts = [];
        let n = node;
        while (n && n.nodeType === 1 && n.tagName !== 'BODY' && parts.length < 5) {
          let part = n.tagName.toLowerCase();
          if (n.id) { part += '#' + n.id; }
          else if (n.className && typeof n.className === 'string') { part += '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.'); }
          parts.unshift(part);
          n = n.parentElement;
        }
        sel = parts.join(' > ');
      } catch {}
      return {
        ref, tag: node.tagName.toLowerCase(), selector: sel,
        value: node.value !== undefined && String(node.value) ? clean(node.value).slice(0, 200) : '',
        placeholder: node.getAttribute('placeholder') || '',
        href: node.href ? node.href.slice(0, 500) : '',
        text: node.tagName === 'INPUT' ? '' : clean(node.textContent || '').slice(0, 280),
        aria: node.getAttribute('aria-label') || '', role: node.getAttribute('role') || ''
      };
    });
    const text = clean((document.body && (document.body.innerText || document.body.textContent)) || '').slice(0, 12000);
    return {
      ok: true,
      snapshot: {
        url: location.href,
        title: document.title,
        text,
        dom: text,
        interactive,
        accessibility: visible('h1,h2,h3,a,button,input,select,textarea,[role="button"],[role="link"]').map((node) => {
          const ref = node.getAttribute('data-hermes-ref') || '';
          const label = clean(node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.textContent || node.value || '').slice(0, 180);
          return `[${ref}] ${node.tagName.toLowerCase()}${label ? ': ' + label : ''}`;
        }).join('\n'),
        signals: []
      }
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function safeNavigationUrl(value, base) {
  try {
    const url = new URL(String(value || '').trim(), base || undefined);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function runNativeTabAction(name, params, tabId, depth = 0) {
  switch (name) {
    case 'navigate': case 'goto': case 'open': {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const url = safeNavigationUrl(params.url || params.href, tab?.url);
      if (!url) return { ok: false, error: 'Navigation requires a valid http(s) URL' };
      await chrome.tabs.update(tabId, { url });
      lastSnapshot = null;
      return { ok: true, value: `navigating to ${url}` };
    }
    case 'back': {
      if (typeof chrome.tabs.goBack !== 'function') return null;
      await chrome.tabs.goBack(tabId);
      lastSnapshot = null;
      return { ok: true, value: 'navigating back' };
    }
    case 'forward': {
      if (typeof chrome.tabs.goForward !== 'function') return null;
      await chrome.tabs.goForward(tabId);
      lastSnapshot = null;
      return { ok: true, value: 'navigating forward' };
    }
    case 'reload': case 'refresh': {
      await chrome.tabs.reload(tabId);
      lastSnapshot = null;
      return { ok: true, value: 'reloading page' };
    }
    case 'snapshot': {
      const snap = await snapshotTab(tabId);
      if (!snap?.snapshot) return { ok: false, error: 'Could not snapshot active page' };
      const cfg = await store.get();
      const maxChars = Math.max(5000, Math.min(100000, Number(cfg.maxDomChars) || 30000));
      return {
        ok: true,
        value: {
          url: snap.url,
          title: snap.title,
          document: String(snap.snapshot.dom || snap.snapshot.text || '').slice(0, maxChars),
          accessibility: String(snap.snapshot.accessibility || '').slice(0, maxChars),
          signals: (snap.snapshot.signals || []).slice(0, 100),
          interactive: (snap.snapshot.interactive || []).slice(0, 250),
          headings: snap.snapshot.summary?.headings || snap.snapshot.headings || [],
          links: (snap.snapshot.links || snap.snapshot.interactive || []).filter((item) => item.href).slice(0, 80)
        }
      };
    }
    case 'tabs':
    case 'pages':
    case 'windows':
    case 'tab_groups':
    case 'tab-groups':
    case 'tabgroups':
    case 'bookmarks':
    case 'history':
    case 'downloads':
    case 'download':
    case 'cookies':
    case 'console':
    case 'dialog':
    case 'handle_dialog':
    case 'zoom':
    case 'viewport':
    case 'sessions':
    case 'top_sites':
    case 'topsites':
    case 'discard':
      return runChromeTool(name, params, tabId);
    case 'screenshot': case 'capture': {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(params.windowId || undefined, { format: params.format === 'jpeg' ? 'jpeg' : 'png', quality: Number(params.quality) || 90 });
        return { ok: true, value: { dataUrl, format: params.format === 'jpeg' ? 'jpeg' : 'png' } };
      } catch (e) {
        return { ok: false, error: `screenshot failed: ${e.message}` };
      }
    }
    case 'pdf': {
      return { ok: false, error: 'PDF export requires the BrowserOS/CDP backend; Chrome MV3 does not expose tabs.printToPDF' };
    }
    case 'upload': {
      return { ok: false, error: 'Upload requires a user-selected file; use the page file input or setInputFiles flow' };
    }
    case 'run': {
      const actions = Array.isArray(params.actions) ? params.actions : [];
      if (!actions.length) return { ok: false, error: 'run requires actions[]' };
      const results = [];
      for (const action of actions) results.push(await runActionOnTab(action, tabId, depth + 1));
      return { ok: results.every((result) => result?.ok !== false), value: results };
    }
    default:
      return null;
  }
}

async function runActionOnTab(action, tabId, depth = 0) {
  const cfg = await store.get();
  if (!cfg.enablePageActing) return { ok: false, error: 'Page acting is disabled in Hermes Browser settings' };
  if (tabId == null) return { ok: false, error: 'No active tab' };
  if (!action || typeof action !== 'object') return { ok: false, error: 'No browser action supplied' };
  if (depth > 8) return { ok: false, error: 'action nest limit exceeded' };

  const name = String(action.name || action.action || '').replace(/^browser[:_-]?/, '').toLowerCase();
  const params = action.params || action.payload || action.args || action;

  const native = await runNativeTabAction(name, params, tabId, depth);
  if (native) return native;

  let resp = await chrome.tabs.sendMessage(tabId, { kind: 'run-action', action }).catch(() => null);
  if (!resp) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/page-reader.js', 'lib/page-actor.js', 'lib/content.js']
    }).catch(() => {});
    resp = await chrome.tabs.sendMessage(tabId, { kind: 'run-action', action }).catch(() => null);
  }
  return resp || { ok: false, error: 'Could not reach page (restricted browser page or content script unavailable)' };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function abortedResult(generation) {
  if (client && (generation == null || client.activeGeneration === generation)) {
    client.busy = false;
    client.cancelRequested = false;
    client.abort = null;
  }
  emit('run-end', { ok: false, aborted: true, error: 'stopped' });
  return { aborted: true };
}

async function chat(userText, opts = {}) {
  if (!client) client = await buildClient();
  const generation = client.prepareRun();
  if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) connectBridgeWs();
  if (client.wasCanceled(generation)) return abortedResult(generation);

  const cfg = await store.get();
  if (client.wasCanceled(generation)) return abortedResult(generation);

  const extra = {};
  const requestedModel = opts.model || cfg.model;
  const requestedProvider = opts.modelProvider || cfg.modelProvider;
  if (requestedModel) extra.model = requestedModel;
  if (requestedProvider) extra.modelProvider = requestedProvider;
  if (cfg.workspace) extra.workspace = cfg.workspace;

  const shouldAttachPage = typeof opts.attachPage === 'boolean' ? opts.attachPage : cfg.attachPageContext !== false;
  if (shouldAttachPage) {
    let snapshot = null;
    try { snapshot = await snapshotTab(opts.tabId); } catch (error) {
      emit('page-context-status', { ok: false, error: String(error) });
    }
    if (snapshot?.snapshot) {
      const dom = snapshot.snapshot.dom || '';
      // MAIN-world inline fallback exposes .text instead of .dom; surface it so
      // Hermes still gets the actual page body on pages without content scripts.
      const doc = dom || snapshot.snapshot.text || '';
      const interactive = (snapshot.snapshot.interactive || []).slice(0, 200);
      const maxDomChars = Math.max(5000, Math.min(100000, Number(cfg.maxDomChars) || 30000));
      extra.attachPage = true;
      extra.attachedTab = { id: snapshot.tabId, url: snapshot.url, title: snapshot.title };
      extra.context = [{
        type: 'page_context',
        url: snapshot.url,
        title: snapshot.title,
        tabId: snapshot.tabId,
        document: doc.slice(0, maxDomChars),
        accessibility: snapshot.snapshot.accessibility || '',
        signals: snapshot.snapshot.signals || [],
        interactive,
        time: Date.now()
      }];
      emit('page-context-status', { ok: true, url: snapshot.url, title: snapshot.title, interactive: interactive.length });
    } else if (shouldAttachPage) {
      emit('page-context-status', { ok: false, error: 'Could not read the active page. It may be a restricted browser page.' });
    }
  }
  if (client.wasCanceled(generation)) return abortedResult(generation);

  emit('run-start', { userText });
  if (client.wasCanceled(generation)) return abortedResult(generation);

  try {
    const input = {
      agentId: 'hermes',
      threadId: opts.threadId || currentThreadId || undefined,
      messages: [
        ...(opts.history || []),
        { role: 'user', content: userText }
      ],
      ...extra
    };
    const result = await client.runAgent(input, { generation });
    if (result.state?.threadId) persistThreadId(result.state.threadId);
    else if (input.threadId) persistThreadId(input.threadId);
    emit('run-end', { ok: true, result });
    return result;
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /abort/i.test(String(e?.message || e));
    if (aborted) {
      if (client.activeGeneration === generation) emit('run-end', { ok: false, aborted: true, error: 'stopped' });
      return { aborted: true };
    }
    emit('run-end', { ok: false, aborted: false, error: String(e) });
    throw e;
  }
}

function clearThread() {
  currentThreadId = null;
  try { chrome.storage?.session?.remove('hermesThreadId'); } catch {}
}

async function loadRuntime() {
  const runtime = await bridgeJson('/v1/runtime');
  lastRuntime = runtime;
  emit('runtime', runtime);
  return runtime;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.bridgeUrl || changes.authToken) {
    lastRuntime = null;
    buildClient().catch(() => {});
    try { bridgeWs?.close(); } catch {}
    bridgeWs = null;
    connectBridgeWs();
  }
});

// ---------------------------------------------------------------------------
// Runtime message API
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.kind) return;
  switch (msg.kind) {
    case 'chat': {
      chat(msg.text, msg).then((r) => sendResponse({ ok: true, aborted: !!r?.aborted, r })).catch((e) => {
        const aborted = e?.name === 'AbortError' || /abort/i.test(String(e));
        sendResponse({ ok: false, aborted, error: aborted ? 'stopped' : String(e) });
      });
      return true;
    }
    case 'abort-run': {
      const aborted = client?.abortRun ? client.abortRun(client.activeGeneration) : false;
      emit('run-end', { ok: false, aborted: Boolean(aborted), error: 'stopped' });
      sendResponse({ ok: true, aborted: Boolean(aborted) });
      return true;
    }
    case 'read-page': {
      snapshotTab(msg.tabId, { fresh: msg.fresh !== false }).then((snap) => sendResponse({ ok: !!snap, snapshot: snap })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'run-action': {
      runActionOnTab(msg.action, msg.tabId || sender.tab?.id).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'get-config': {
      store.get().then((cfg) => sendResponse({ ok: true, config: cfg })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'set-config': {
      store.set(msg.patch || {}).then(async () => {
        const keys = Object.keys(msg.patch || {});
        if (keys.some((key) => key === 'bridgeUrl' || key === 'authToken')) {
          lastRuntime = null;
          await buildClient();
        }
        sendResponse({ ok: true });
      }).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'get-models': {
      bridgeJson('/v1/models')
        .then((data) => sendResponse({ ok: true, ...data }))
        .catch((e) => sendResponse({ ok: false, error: String(e), data: [] }));
      return true;
    }
    case 'get-runtime': {
      if (lastRuntime && !msg.refresh && lastRuntime.summary?.companionTools) {
        sendResponse({ ok: true, ...lastRuntime });
        return true;
      }
      loadRuntime()
        .then((data) => sendResponse({ ok: true, ...data }))
        .catch((e) => sendResponse({ ok: false, error: String(e), toolsets: [], skills: [] }));
      return true;
    }
    case 'clear-thread': {
      clearThread();
      sendResponse({ ok: true });
      return true;
    }
    case 'get-state': {
      sendResponse({
        ok: true,
        threadId: currentThreadId,
        snapshot: lastSnapshot,
        ownedTabId,
        runtime: lastRuntime,
        clientBusy: client ? client.busy : false,
        bridgeConnected: bridgeWs?.readyState === WebSocket.OPEN
      });
      return true;
    }
    case 'action-batch': {
      (async () => {
        const results = [];
        for (const action of msg.actions || []) results.push(await runActionOnTab(action, msg.tabId || sender.tab?.id));
        sendResponse({ ok: results.every((result) => result?.ok !== false), results });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'tab-changed': {
      const senderTabId = sender.tab?.id;
      if (senderTabId == null || senderTabId === ownedTabId) {
        lastSnapshot = null;
        emit('tab-changed', { url: msg.url, title: msg.title, tabId: senderTabId });
      }
      sendResponse({ ok: true });
      return true;
    }
  }
  return false;
});

// ---------------------------------------------------------------------------
// UI ports
// ---------------------------------------------------------------------------
const portClients = new Set();
chrome.runtime.onConnect.addListener((port) => {
  portClients.add(port);
  port.onDisconnect.addListener(() => portClients.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.kind === 'hello') {
      // Opening the side panel is the reliable MV3 wake signal. Re-attempt the
      // bridge connection immediately instead of waiting for the old timer.
      connectBridgeWs();
      port.postMessage({
        kind: 'state',
        threadId: currentThreadId,
        runtime: lastRuntime,
        clientBusy: client ? client.busy : false,
        bridgeConnected: bridgeWs?.readyState === WebSocket.OPEN
      });
    }
  });
});

function relayToPorts(type, payload) {
  portClients.forEach((port) => {
    try { port.postMessage({ kind: type, ...payload }); } catch {}
  });
}
relay.addEventListener('agui-event', (e) => relayToPorts('event', { event: e.detail }));
relay.addEventListener('run-start', (e) => relayToPorts('run-start', { text: e.detail.userText }));
relay.addEventListener('run-end', (e) => relayToPorts('run-end', { ok: e.detail.ok, aborted: e.detail.aborted, error: e.detail.error }));
relay.addEventListener('page-snapshot', (e) => relayToPorts('page-snapshot', { snapshot: e.detail }));
relay.addEventListener('page-context-status', (e) => relayToPorts('page-context-status', e.detail));
relay.addEventListener('bridge-status', (e) => relayToPorts('bridge-status', e.detail));
relay.addEventListener('agent-state', (e) => relayToPorts('agent-state', e.detail));
relay.addEventListener('runtime', (e) => relayToPorts('runtime', { runtime: e.detail }));

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === ownedTabId) {
      clearOwnedTab();
      lastSnapshot = null;
    }
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id != null && !isRestrictedUrl(tab.url)) pinOwnedTab(tab);
  if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (chrome.sidePanel && tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

buildClient();
setInterval(() => { /* open UI ports keep the service worker active during runs */ }, 20000);

console.log('[Hermes Browser] background loaded');