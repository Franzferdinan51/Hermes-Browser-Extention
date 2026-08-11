/**
 * background.js — Manifest V3 service worker (module).
 *
 * The extension's control plane. Owns:
 *   - configuration (bridge URL, auth, model, workspace) in chrome.storage
 *   - the AG-UI client connection to the local Hermes bridge
 *   - routing Hermes tool calls (TOOL_CALL_*) to the active-tab page actor
 *     and feeding results back to the bridge for the agent's next step
 *   - the side panel and popup event relay (reads, streaming, state)
 *   - current-page snapshot cache for context injection
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
let runningRun = null;

function bridgeAgentUrl() { return store.get().then((c) => `${c.bridgeUrl.replace(/\/$/, '')}/agent`); }

async function buildClient() {
  const cfg = await store.get();
  if (client) { client.removeAll(); }
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
    if (evt.type === 'TOOL_CALL_END' || evt.type === 'tool-result-request') return;
    if (evt.type === 'TOOL_CALL_START' && evt.name) {
      // Real execution is handled through bridge browser-action messages.
    }
  } catch (e) { console.error('handleEvent', e); }
}

let bridgeWs = null;

async function wsBridgeUrl() {
  const c = await store.get();
  const b = c.bridgeUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
  return `${b}/ws`;
}

function connectBridgeWs() {
  try { if (bridgeWs && (bridgeWs.readyState === 0 || bridgeWs.readyState === 1)) return; }
  catch { bridgeWs = null; }
  wsBridgeUrl().then((url) => {
    try { bridgeWs = new WebSocket(url); }
    catch { return; }
    bridgeWs.onopen = () => console.log('[Hermes] bridge WS open');
    bridgeWs.onmessage = async (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.kind === 'browser-action') {
        let tab;
        try { tab = await getActiveTab(); } catch { tab = null; }
        let result = { ok: false, error: 'no active tab' };
        if (tab && tab.id != null) result = await runActionOnTab(msg.action, tab.id);
        if (bridgeWs.readyState === 1) {
          bridgeWs.send(JSON.stringify({ kind: 'browser-result', result }));
        }
      }
    };
    bridgeWs.onclose = () => {
      bridgeWs = null;
      setTimeout(connectBridgeWs, 4000);
    };
    bridgeWs.onerror = () => { try { bridgeWs.close(); } catch {} };
  });
}
connectBridgeWs();

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function snapshotTab(tabId) {
  const tabs = tabId ? [{ id: tabId }] : await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || tab.id == null) throw new Error('No tab');
  const resp = await chrome.tabs.sendMessage(tab.id, { kind: 'read-page' }).catch(() => null);
  if (resp && resp.ok && resp.snapshot) {
    lastSnapshot = { tabId: tab.id, url: tab.url, title: tab.title, snapshot: resp.snapshot };
    emit('page-snapshot', lastSnapshot);
    return lastSnapshot;
  }
  const snap = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['lib/page-reader.js']
  }).then(() => chrome.tabs.sendMessage(tab.id, { kind: 'read-page' })).catch(() => null);
  if (snap && snap.ok) {
    lastSnapshot = { tabId: tab.id, url: tab.url, title: tab.title, snapshot: snap.snapshot };
    emit('page-snapshot', lastSnapshot);
    return lastSnapshot;
  }
  return null;
}

async function runActionOnTab(action, tabId) {
  const cfg = await store.get();
  if (!cfg.enablePageActing) {
    return { ok: false, error: 'Page acting is disabled in Hermes Browser settings' };
  }
  if (tabId == null) return { ok: false, error: 'No active tab' };

  let resp = await chrome.tabs.sendMessage(tabId, { kind: 'run-action', action }).catch(() => null);
  if (!resp) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/page-actor.js'] }).catch(() => {});
    resp = await chrome.tabs.sendMessage(tabId, { kind: 'run-action', action }).catch(() => null);
  }
  return resp || { ok: false, error: 'Could not reach page (maybe restricted page)' };
}

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
  let snapshot = null;
  if (shouldAttachPage) {
    try { snapshot = await snapshotTab(opts.tabId); } catch {}
    if (snapshot && snapshot.snapshot) {
      const dom = snapshot.snapshot.dom || '';
      const interactive = (snapshot.snapshot.interactive || []).slice(0, 200);
      const maxDomChars = Math.max(5000, Math.min(100000, Number(cfg.maxDomChars) || 30000));
      const ctx = {
        type: 'page_context',
        url: snapshot.url,
        title: snapshot.title,
        document: dom.slice(0, maxDomChars),
        accessibility: snapshot.snapshot.accessibility || '',
        interactive,
        time: Date.now()
      };
      extra.context = [ctx];
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
    if (result.state && result.state.threadId) currentThreadId = result.state.threadId;
    emit('run-end', { ok: true, result });
    return result;
  } catch (e) {
    emit('run-end', { ok: false, error: String(e) });
    throw e;
  }
}

function clearThread() { currentThreadId = null; }

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.bridgeUrl || changes.authToken)) buildClient().then(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.kind) return;
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
      store.set(msg.patch || {}).then(async () => { await buildClient(); sendResponse({ ok: true }); }).catch((e) => sendResponse({ ok: false, error: String(e) }));
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
      sendResponse({ ok: true, threadId: currentThreadId, snapshot: lastSnapshot, clientBusy: client ? client.busy : false });
      return true;
    }
    case 'action-batch': {
      (async () => {
        const results = [];
        for (const a of msg.actions || []) {
          results.push(await runActionOnTab(a, msg.tabId || sender.tab?.id));
        }
        sendResponse({ ok: results.every((r) => r?.ok !== false), results });
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

const portClients = new Set();
chrome.runtime.onConnect.addListener((port) => {
  portClients.add(port);
  port.onDisconnect.addListener(() => portClients.delete(port));
  port.onMessage.addListener((m) => {
    if (m.kind === 'hello') port.postMessage({ kind: 'state', threadId: currentThreadId, clientBusy: client ? client.busy : false });
  });
});
function relayToPorts(type, payload) {
  portClients.forEach((p) => { try { p.postMessage({ kind: type, ...payload }); } catch {} });
}
relay.addEventListener('agui-event', (e) => relayToPorts('event', { event: e.detail }));
relay.addEventListener('run-start', (e) => relayToPorts('run-start', { text: e.detail.userText }));
relay.addEventListener('run-end', (e) => relayToPorts('run-end', { ok: e.detail.ok, error: e.detail.error }));
relay.addEventListener('page-snapshot', (e) => relayToPorts('page-snapshot', { snapshot: e.detail }));

chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (chrome.sidePanel && tab.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

buildClient();
setInterval(() => { /* open UI ports keep the service worker active during runs */ }, 20000);

console.log('[Hermes Browser] background loaded');