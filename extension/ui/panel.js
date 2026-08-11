// panel.js — full side panel client. Renders AG-UI event stream, page
// snapshot info, and tool-call timeline. Keeps an open port to the SW so the
// service worker stays alive during a run and hears live events.
const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const emptyEl = $('empty');

let port = null;
let busy = false;
let config = null;

// ---- render helpers ----
function addEl(cls, text) {
  emptyEl.style.display = 'none';
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}

function openAssistant() {
  const d = document.createElement('div');
  d.className = 'msg assistant streaming';
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '▋';
  d.appendChild(caret);
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return { el: d, caret };
}

let currentStream = null;   // {el, caret}
let currentTool = null;     // {el, argsEl}

function appendStream(text) {
  if (!currentStream) currentStream = openAssistant();
  // remove caret, append text, re-add caret
  if (currentStream.caret.parentNode) currentStream.caret.parentNode.removeChild(currentStream.caret);
  currentStream.el.textContent += text;
  // Re-append caret only while streaming (we keep it, and strip on finalize)
  currentStream.el.appendChild(currentStream.caret);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function finalizeStream() {
  if (!currentStream) return;
  if (currentStream.caret && currentStream.caret.parentNode) currentStream.caret.parentNode.removeChild(currentStream.caret);
  currentStream.el.classList.remove('streaming');
  currentStream = null;
}

function openTool(name) {
  const d = document.createElement('div');
  d.className = 'msg tool';
  const head = document.createElement('div');
  head.className = 'toolhead';
  head.textContent = '🧰 ' + (name || 'tool');
  const args = document.createElement('div');
  args.className = 'toolargs';
  d.appendChild(head);
  d.appendChild(args);
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  currentTool = { el: d, argsEl: args, name };
  return d;
}

function appendToolArgs(delta) {
  if (!currentTool) return;
  if (currentTool.el.classList.contains('pending')) return;
  currentTool.argsEl.textContent += delta || '';
  chatEl.scrollTop = chatEl.scrollHeight;
}

function finalizeTool(resultOk, resultText) {
  if (!currentTool) return;
  currentTool.el.classList.add(resultOk ? 'ok' : 'err');
  if (resultText) {
    const res = document.createElement('div');
    res.className = 'toolargs';
    res.textContent = '→ ' + String(resultText).slice(0, 500);
    currentTool.el.appendChild(res);
  }
  currentTool = null;
}

// ---- AG-UI event rendering ----
const THROTTLE = 24; // ms batching for fast streams
let pendingText = '';
let textTimer = null;
function queueText(delta) {
  pendingText += delta;
  if (textTimer) return;
  textTimer = setTimeout(() => {
    appendStream(pendingText);
    pendingText = '';
    textTimer = null;
  }, THROTTLE);
}

let lastRenderedError = '';
function showError(text) {
  const normalized = String(text || 'unknown').replace(/^Error:\s*/i, '');
  if (normalized === lastRenderedError) return;
  lastRenderedError = normalized;
  addEl('err', 'Error: ' + normalized);
  setTimeout(() => { if (lastRenderedError === normalized) lastRenderedError = ''; }, 1500);
}

function handleEvent(e) {
  const t = e.type;
  switch (t) {
    case 'RUN_STARTED':
      setStatus('busy');
      $('runInfo').textContent = 'running…';
      break;
    case 'TEXT_MESSAGE_START':
    case 'TEXT_MESSAGE_CHUNK':
      currentStream = openAssistant();
      if (e.delta) queueText(e.delta);
      break;
    case 'TEXT_MESSAGE_CONTENT':
      if (e.delta) queueText(e.delta);
      break;
    case 'TEXT_MESSAGE_END':
      flushText();
      finalizeStream();
      break;
    case 'TOOL_CALL_START':
      openTool(e.name || e.toolName || (e.args && JSON.parse(e.args || '{}').name) || 'tool');
      break;
    case 'TOOL_CALL_ARGS':
      appendToolArgs(e.delta || '');
      break;
    case 'TOOL_CALL_CHUNK':
      if (e.args) appendToolArgs(e.args);
      break;
    case 'TOOL_CALL_END':
      // tool done — result arrives via separate result message
      break;
    // Tool result notification (bridge -> extension -> panel)
    case 'tool-result':
      finalizeTool(e.ok, e.value || e.error);
      break;
    case 'STATE_SNAPSHOT':
    case 'MESSAGES_SNAPSHOT':
      // optionally render compactly
      break;
    case 'RUN_FINISHED':
      flushText();
      finalizeStream();
      if (currentTool) finalizeTool(true);
      setStatus('ok');
      $('runInfo').textContent = 'done';
      break;
    case 'RUN_ERROR':
      flushText();
      finalizeStream();
      if (currentTool) finalizeTool(false, e.error || e.message);
      showError(e.error || e.message || 'unknown');
      setStatus('err');
      $('runInfo').textContent = 'error';
      break;
    case 'CUSTOM':
      if (e.kind === 'tool-result') finalizeTool(e.ok, e.value || e.error);
      break;
    default:
      break;
  }
}

function flushText() {
  if (pendingText && textTimer) { clearTimeout(textTimer); textTimer = null; appendStream(pendingText); pendingText = ''; }
}

// ---- status ----
function setStatus(state) {
  const el = $('phStatus');
  el.className = 'ph-status ' + state;
  el.title = state;
}

// ---- port to SW for live events ----
function connectPort() {
  try { port = chrome.runtime.connect({ name: 'panel' }); } catch { return; }
  port.onMessage.addListener((m) => {
    if (m.kind === 'event' && m.event) handleEvent(m.event);
    else if (m.kind === 'state') {
      setStatus(m.clientBusy ? 'busy' : 'ok');
    } else if (m.kind === 'run-start') { busy = true; }
    else if (m.kind === 'run-end') { busy = false; }
    else if (m.kind === 'page-snapshot' && m.snapshot) updatePageBar(m.snapshot);
  });
  port.onDisconnect.addListener(() => { port = null; });
  port.postMessage({ kind: 'hello' });
}

// ---- page snapshot ----
async function updatePageBar() {
  const r = await chrome.runtime.sendMessage({ kind: 'get-state' }).catch(() => null);
  const snap = r && r.snapshot;
  if (snap) {
    $('pageTitle').textContent = (snap.snapshot && snap.snapshot.title) || snap.url || '—';
    $('pageTitle').title = snap.url || '';
  }
}

async function snapshotNow() {
  const r = await chrome.runtime.sendMessage({ kind: 'read-page' }).catch(() => null);
  if (r && r.ok) updatePageBar();
}

async function loadModels(selected, selectedProvider) {
  const select = $('modelSelect');
  select.innerHTML = '<option>Loading models…</option>';
  const r = await chrome.runtime.sendMessage({ kind: 'get-models' }).catch(() => null);
  const models = r && r.ok ? (r.data || []) : [];
  if (!models.length) {
    select.innerHTML = '<option value="qwen3.5-9b">qwen3.5-9b</option>';
    select.value = selected || 'qwen3.5-9b';
    return;
  }
  const groups = new Map();
  for (const m of models) {
    const key = m.providerLabel || m.provider || 'Models';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  select.innerHTML = '';
  for (const [group, entries] of groups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const m of entries) {
      const option = document.createElement('option');
      option.value = m.id;
      option.dataset.provider = m.provider || '';
      option.textContent = m.label || m.id;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
  const match = [...select.options].find((o) => o.value === selected && (!selectedProvider || o.dataset.provider === selectedProvider));
  select.value = match ? match.value : (r.default_model || select.options[0]?.value || '');
}

async function chooseModel() {
  const option = $('modelSelect').selectedOptions[0];
  if (!option?.value) return;
  await chrome.runtime.sendMessage({ kind: 'set-config', patch: {
    model: option.value,
    modelProvider: option.dataset.provider || config?.modelProvider || ''
  }});
  config = { ...(config || {}), model: option.value, modelProvider: option.dataset.provider || config?.modelProvider || '' };
  $('runInfo').textContent = 'model saved';
  setTimeout(() => { if (!busy) $('runInfo').textContent = ''; }, 1200);
}

// ---- send ----
async function send() {
  const text = $('prompt').value.trim();
  if (!text || busy) return;
  $('prompt').value = '';
  emptyEl.style.display = 'none';
  busy = true;
  addEl('user', text);
  setStatus('busy');
  $('runInfo').textContent = 'running…';
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'chat', text, attachPage: $('autoSnap').checked });
    if (response && !response.ok) throw new Error(response.error || 'Chat request failed');
  } catch (e) {
    showError(e);
    setStatus('err');
    $('runInfo').textContent = 'error';
  }
  busy = false;
}

// ---- init ----
$('send').addEventListener('click', send);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  setTimeout(autoGrow, 0);
});
function autoGrow() {
  const t = $('prompt');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 140) + 'px';
}
$('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btnClear').addEventListener('click', async () => {
  chatEl.innerHTML = '';
  emptyEl.style.display = '';
  currentStream = currentTool = null;
  await chrome.runtime.sendMessage({ kind: 'clear-thread' });
});
$('btnSnapshot').addEventListener('click', snapshotNow);

(async () => {
  const r = await chrome.runtime.sendMessage({ kind: 'get-config' }).catch(() => null);
  if (r && r.ok) {
    config = r.config;
    $('autoSnap').checked = config.attachPageContext !== false;
    await loadModels(config.model, config.modelProvider);
  }
})();

$('modelSelect').addEventListener('change', chooseModel);
$('refreshModels').addEventListener('click', () => loadModels(config?.model, config?.modelProvider));
connectPort();
updatePageBar();
console.log('[HermesPanel] ready');