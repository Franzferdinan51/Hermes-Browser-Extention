/**
 * background.js — Manifest V3 service worker.
 *
 * Owns configuration, the AG-UI client, Hermes bridge WebSocket, page context,
 * browser-tool execution, and UI event relaying.
 */

import { AGUIClient } from './agui-client.js';

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:8965',
  authToken: '',
  model: 'qwen3.5-9b',
  modelProvider: 'lmstudio',
  workspace: '',
  autoSnapshot: false, // legacy key; attachPageContext is the source of truth
  attachPageContext: true,
  maxDomChars: 30000,
  enablePageActing: true
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

async function buildClient() {
  const cfg = await store.get();
  if (client) client.removeAll();
  client = new AGUIClient({
    url: `${cfg.bridgeUrl.replace(/\/$/, '')}/agent`,
    headers: cfg.authToken ? { Authorization: `Bearer ${cfg.authToken}` } : {},
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
    // Browser execution is driven by bridge WebSocket browser-action messages.
    // AG-UI events are still relayed to all open UI surfaces for rendering.
    if (evt.type === 'RUN_STARTED') emit('agent-state', { phase: 'running' });
    else if (evt.type === 'RUN_FINISHED') emit('agent-state', { phase: 'done' });
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

async function wsBridgeUrl() {
  const c = await store.get();
  return `${c.bridgeUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')}/ws`;
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
    if (bridgeWs && (bridgeWs.readyState === WebSocket.CONNECTING || bridgeWs.readyState === WebSocket.OPEN)) return;
  } catch {
    bridgeWs = null;
  }

  wsBridgeUrl().then((url) => {
    try { bridgeWs = new WebSocket(url); }
    catch {
      scheduleBridgeReconnect();
      return;
    }

    bridgeWs.onopen = () => {
      console.log('[Hermes] bridge WS open');
      emit('bridge-status', { connected: true });
    };

    bridgeWs.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.kind !== 'browser-action') return;

      let tab = null;
      try { tab = await getActiveTab(); } catch {}
      let result = { ok: false, error: 'no active tab' };
      if (tab?.id != null) result = await runActionOnTab(msg.action, tab.id);

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
      bridgeWs = null;
      emit('bridge-status', { connected: false });
      scheduleBridgeReconnect();
    };
    bridgeWs.onerror = () => {
      try { bridgeWs.close(); } catch {}
    };
  }).catch(() => scheduleBridgeReconnect());
}
connectBridgeWs();

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ---------------------------------------------------------------------------
// Page context and browser actions
// ---------------------------------------------------------------------------
async function snapshotTab(tabId) {
  const tabs = tabId ? [{ id: tabId }] : await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No tab');

  let resp = await chrome.tabs.sendMessage(tab.id, { kind: 'read-page' }).catch(() => null);
  if (!resp) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['lib/page-reader.js', 'lib/page-actor.js', 'lib/content.js']
    }).catch(() => {});
    resp = await chrome.tabs.sendMessage(tab.id, { kind: 'read-page' }).catch(() => null);
  }

  if (resp?.ok && resp.snapshot) {
    lastSnapshot = { tabId: tab.id, url: tab.url, title: tab.title, snapshot: resp.snapshot };
    emit('page-snapshot', lastSnapshot);
    return lastSnapshot;
  }
  return null;
}

function safeNavigationUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function runNativeTabAction(name, params, tabId) {
  switch (name) {
    case 'navigate': case 'goto': case 'open': {
      const url = safeNavigationUrl(params.url || params.href);
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
          document: String(snap.snapshot.dom || '').slice(0, maxChars),
          accessibility: String(snap.snapshot.accessibility || '').slice(0, maxChars),
          interactive: (snap.snapshot.interactive || []).slice(0, 250)
        }
      };
    }
    default:
      return null;
  }
}

async function runActionOnTab(action, tabId) {
  const cfg = await store.get();
  if (!cfg.enablePageActing) return { ok: false, error: 'Page acting is disabled in Hermes Browser settings' };
  if (tabId == null) return { ok: false, error: 'No active tab' };
  if (!action || typeof action !== 'object') return { ok: false, error: 'No browser action supplied' };

  const name = String(action.name || action.action || '').replace(/^browser[:_-]?/, '').toLowerCase();
  const params = action.params || action.payload || action.args || action;

  const native = await runNativeTabAction(name, params, tabId);
  if (native) return native;

  let resp = await chrome.tabs.sendMessage(tabId, { kind: 'run-action', action }).catch(() => null);
  if (!resp) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/page-reader.js', 'lib/page-actor.js', 'lib/content.js'] }).catch(() => {});
    resp = await chrome.tabs.sendMessage(tabId, { kind: 'run-action', action }).catch(() => null);
  }
  return resp || { ok: false, error: 'Could not reach page (restricted browser page or content script unavailable)' };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
async function chat(userText, opts = {}) {
  const cfg = await store.get();
  if (!client) client = await buildClient();

  const extra = {};
  const requestedModel = opts.model || cfg.model;
  const requestedProvider = opts.modelProvider || cfg.modelProvider;
  if (requestedModel) extra.model = requestedModel;
  if (requestedProvider) extra.modelProvider = requestedProvider;
  if (cfg.workspace) extra.workspace = cfg.workspace;

  const shouldAttachPage = typeof opts.attachPage === 'boolean' ? opts.attachPage : cfg.attachPageContext !== false;
  if (shouldAttachPage) {
    let snapshot = null;
    try { snapshot = await snapshotTab(opts.tabId); } catch {}
    if (snapshot?.snapshot) {
      const dom = snapshot.snapshot.dom || '';
      const interactive = (snapshot.snapshot.interactive || []).slice(0, 200);
      const maxDomChars = Math.max(5000, Math.min(100000, Number(cfg.maxDomChars) || 30000));
      extra.context = [{
        type: 'page_context',
        url: snapshot.url,
        title: snapshot.title,
        document: dom.slice(0, maxDomChars),
        accessibility: snapshot.snapshot.accessibility || '',
        interactive,
        time: Date.now()
      }];
    }
  }

  emit('run-start', { userText });

  try {
    const input = {
      agentId: 'hermes',
      threadId: currentThreadId || undefined,
      messages: [
        ...(opts.history || []),
        { role: 'user', content: userText }
      ],
      ...extra
    };
    const result = await client.runAgent(input);
    if (result.state?.threadId) currentThreadId = result.state.threadId;
    emit('run-end', { ok: true, result });
    return result;
  } catch (e) {
    emit('run-end', { ok: false, error: String(e) });
    throw e;
  }
}

function clearThread() {
  currentThreadId = null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.bridgeUrl || changes.authToken) {
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
      chat(msg.text, msg).then((r) => sendResponse({ ok: true, r })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'read-page': {
      snapshotTab(msg.tabId).then((snap) => sendResponse({ ok: !!snap, snapshot: snap })).catch((e) => sendResponse({ ok: false, error: String(e) }));
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
        await buildClient();
        sendResponse({ ok: true });
      }).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'get-models': {
      (async () => {
        const cfg = await store.get();
        const url = `${cfg.bridgeUrl.replace(/\/$/, '')}/v1/models`;
        const r = await fetch(url, { headers: cfg.authToken ? { Authorization: `Bearer ${cfg.authToken}` } : {} });
        const data = await r.json();
        sendResponse({ ok: r.ok && !data.error, ...data });
      })().catch((e) => sendResponse({ ok: false, error: String(e), data: [] }));
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
      lastSnapshot = null;
      emit('tab-changed', { url: msg.url, title: msg.title });
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
      port.postMessage({
        kind: 'state',
        threadId: currentThreadId,
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
relay.addEventListener('run-end', (e) => relayToPorts('run-end', { ok: e.detail.ok, error: e.detail.error }));
relay.addEventListener('page-snapshot', (e) => relayToPorts('page-snapshot', { snapshot: e.detail }));
relay.addEventListener('bridge-status', (e) => relayToPorts('bridge-status', e.detail));
relay.addEventListener('agent-state', (e) => relayToPorts('agent-state', e.detail));

chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (chrome.sidePanel && tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

buildClient();
setInterval(() => { /* open UI ports keep the service worker active during runs */ }, 20000);

console.log('[Hermes Browser] background loaded');