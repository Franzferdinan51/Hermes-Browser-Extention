// popup.js — compact chat popup. Streams AG-UI events via the runtime port and
// renders simple assistant/user/tool bubbles. Keeps the SW alive while open.
import { abortSucceeded, shouldIdleComposer } from '../lib/agui-client.js';
import { pageIdentity, pageIdentityFallback, shouldApplyPageIdentity, visibleError, connectionState } from '../lib/thread.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function hideEmptyHint() {
  const hint = $('emptyHint');
  if (hint) hint.remove();
}

function appendMsg(cls, text) {
  hideEmptyHint();
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function showPage(source) {
  const id = pageIdentity(source || {});
  if (!shouldApplyPageIdentity(id)) return;
  $('pageLabel').textContent = id.empty ? pageIdentityFallback() : id.label;
  $('pageLabel').title = id.url || id.label;
}

function applyConnection(source) {
  const conn = connectionState(source);
  setStatus(conn.kind, conn.label);
}

let port = null;
let busy = false;
let liveSend = 0;

function setStatus(dot, text) {
  $('dot').className = 'dot ' + dot;
  $('statusText').textContent = text;
}

// Open a port to the SW to keep it alive + hear live events.
function connect() {
  port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((m) => {
    if (m.kind === 'event' && m.event) {
      const e = m.event;
      if (e.type === 'TEXT_MESSAGE_CONTENT') $('statusText').textContent = 'streaming…';
      if (e.type === 'TOOL_CALL_START') appendMsg('tool', `🔧 ${e.name || e.toolName || 'tool'}`);
      if (e.type === 'RUN_ERROR') appendMsg('err', 'Error: ' + visibleError(e.error || e.message));
    } else if (m.kind === 'state') {
      applyConnection({ bridgeConnected: m.bridgeConnected !== false, clientBusy: m.clientBusy });
      if (m.page || m.snapshot) showPage(m);
    } else if (m.kind === 'run-start') {
      setPopupBusy(true, 'working');
    } else if (m.kind === 'run-end') {
      if (shouldIdleComposer(m.sendToken, liveSend)) {
        setPopupBusy(false, m.aborted ? 'stopped' : (m.ok === false ? 'error' : 'connected'));
      }
    } else if (m.kind === 'page-snapshot' && m.snapshot) {
      showPage(m.snapshot);
    } else if (m.kind === 'thread-changed') {
      showPage(m);
    } else if (m.kind === 'page-context-status') {
      showPage(m);
    } else if (m.kind === 'bridge-status') {
      applyConnection({ bridgeConnected: m.connected, clientBusy: busy });
    }
  });
  port.postMessage({ kind: 'hello' });
  port.onDisconnect.addListener(() => { port = null; applyConnection({ bridgeConnected: false, clientBusy: busy }); });
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ kind: 'get-state' }).catch(() => null);
  if (!st) {
    showPage({});
    applyConnection({ bridgeConnected: false });
    return;
  }
  applyConnection({ bridgeConnected: st.bridgeConnected, clientBusy: st.clientBusy });
  showPage(st);
}

function setPopupBusy(on, label) {
  busy = !!on;
  $('send').hidden = busy;
  $('btnStop').hidden = !busy;
  if (label !== undefined) setStatus(busy ? 'busy' : 'ok', label);
}

async function send() {
  const text = $('prompt').value.trim();
  if (!text || busy) return;
  const sendToken = ++liveSend;
  $('prompt').value = '';
  appendMsg('user', text);
  setPopupBusy(true, 'working');
  const r = await chrome.runtime.sendMessage({ kind: 'chat', text, sendToken }).catch((e) => ({ ok: false, error: String(e) }));
  if (!shouldIdleComposer(sendToken, liveSend)) return;
  if (r?.aborted) {
    setPopupBusy(false, 'stopped');
    return;
  }
  if (r && r.ok) {
    const msgs = (r.r && r.r.messages) || [];
    const asst = msgs.filter((m) => m.role !== 'user').map((m) => m.text || '').filter(Boolean).join('');
    if (asst) appendMsg('assistant', asst);
    setPopupBusy(false, 'connected');
  } else {
    appendMsg('err', 'Error: ' + visibleError(r && r.error));
    setPopupBusy(false, 'error');
  }
}

$('btnStop').addEventListener('click', async () => {
  const sendToken = liveSend;
  const response = await chrome.runtime.sendMessage({ kind: 'abort-run' }).catch(() => null);
  if (!abortSucceeded(response)) return;
  if (shouldIdleComposer(sendToken, liveSend)) setPopupBusy(false, 'stopped');
});
$('send').addEventListener('click', send);
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('clear').addEventListener('click', async () => {
  logEl.innerHTML = '';
  const hint = document.createElement('div');
  hint.id = 'emptyHint';
  hint.textContent = 'New conversation on this tab. Other tabs keep their chats. Ask about this page.';
  logEl.appendChild(hint);
  await chrome.runtime.sendMessage({ kind: 'clear-thread' });
});
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openPanel').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (chrome.sidePanel && tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  window.close();
});
$('snap').addEventListener('click', async () => { await chrome.runtime.sendMessage({ kind: 'read-page' }); refresh(); });

connect();
refresh();
