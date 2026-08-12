// popup.js — compact chat popup. Streams AG-UI events via the runtime port and
// renders simple assistant/user/tool bubbles. Keeps the SW alive while open.
import { abortSucceeded, shouldIdleComposer } from '../lib/agui-client.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function appendMsg(cls, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
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
    } else if (m.kind === 'state') {
      setStatus(m.clientBusy ? 'busy' : 'ok', m.clientBusy ? 'running' : 'connected');
    } else if (m.kind === 'page-snapshot' && m.snapshot) {
      $('pageLabel').textContent = m.snapshot.title || m.snapshot.url || '—';
    } else if (m.kind === 'page-context-status' && (m.title || m.url)) {
      $('pageLabel').textContent = m.title || m.url;
    }
  });
  port.postMessage({ kind: 'hello' });
  port.onDisconnect.addListener(() => { port = null; });
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ kind: 'get-state' }).catch(() => null);
  if (st && st.snapshot) {
    $('pageLabel').textContent = st.snapshot.title || st.snapshot.url || '—';
  }
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
  setPopupBusy(true, 'running…');
  const r = await chrome.runtime.sendMessage({ kind: 'chat', text, sendToken }).catch((e) => ({ ok: false, error: String(e) }));
  if (!shouldIdleComposer(sendToken, liveSend)) return;
  if (r?.aborted) {
    setPopupBusy(false, 'stopped');
    return;
  }
  if (r && r.ok) {
    // Reconstruct assistant reply from result.messages
    const msgs = (r.r && r.r.messages) || [];
    const asst = msgs.filter((m) => m.role !== 'user').map((m) => m.text || '').filter(Boolean).join('');
    if (asst) appendMsg('assistant', asst);
    setPopupBusy(false, 'done');
  } else {
    appendMsg('err', 'Error: ' + (r && r.error ? r.error : 'unknown'));
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
$('clear').addEventListener('click', async () => { logEl.innerHTML = ''; await chrome.runtime.sendMessage({ kind: 'clear-thread' }); });
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openPanel').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (chrome.sidePanel && tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  window.close();
});
$('snap').addEventListener('click', async () => { await chrome.runtime.sendMessage({ kind: 'read-page' }); refresh(); });

connect();
refresh();