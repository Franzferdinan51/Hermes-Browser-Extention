// panel.js — full side panel client. Renders AG-UI events, page context,
// tool calls, and a searchable model picker.
const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const emptyEl = $('empty');

let port = null;
let busy = false;
let config = null;
let allModels = [];
let selectedModelId = '';
let selectedProvider = '';

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

let currentStream = null;
let currentTool = null;

function appendStream(text) {
  if (!currentStream) currentStream = openAssistant();
  if (currentStream.caret.parentNode) currentStream.caret.parentNode.removeChild(currentStream.caret);
  currentStream.el.textContent += text;
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
  if (!currentTool || currentTool.el.classList.contains('pending')) return;
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

const THROTTLE = 24;
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

function toolNameFromEvent(e) {
  if (e.name || e.toolName) return e.name || e.toolName;
  if (!e.args) return 'tool';
  try { return JSON.parse(e.args).name || 'tool'; } catch { return 'tool'; }
}

function handleEvent(e) {
  const t = e.type;
  switch (t) {
    case 'RUN_STARTED':
      setStatus('busy');
      $('runInfo').textContent = 'running…';
      break;
    case 'TEXT_MESSAGE_START':
      if (!currentStream) currentStream = openAssistant();
      if (e.delta) queueText(e.delta);
      break;
    case 'TEXT_MESSAGE_CHUNK':
    case 'TEXT_MESSAGE_CONTENT':
      if (e.delta) queueText(e.delta);
      break;
    case 'TEXT_MESSAGE_END':
      flushText();
      finalizeStream();
      break;
    case 'TOOL_CALL_START':
      openTool(toolNameFromEvent(e));
      break;
    case 'TOOL_CALL_ARGS':
      appendToolArgs(e.delta || '');
      break;
    case 'TOOL_CALL_CHUNK':
      if (e.args) appendToolArgs(e.args);
      break;
    case 'TOOL_CALL_END':
      break;
    case 'tool-result':
      finalizeTool(e.ok, e.value || e.error);
      break;
    case 'STATE_SNAPSHOT':
    case 'MESSAGES_SNAPSHOT':
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
  if (pendingText) {
    if (textTimer) clearTimeout(textTimer);
    textTimer = null;
    appendStream(pendingText);
    pendingText = '';
  }
}

function setStatus(state) {
  const el = $('phStatus');
  el.className = 'ph-status ' + state;
  el.title = state;
}

function connectPort() {
  try { port = chrome.runtime.connect({ name: 'panel' }); } catch { return; }
  port.onMessage.addListener((m) => {
    if (m.kind === 'event' && m.event) handleEvent(m.event);
    else if (m.kind === 'state') setStatus(m.clientBusy ? 'busy' : 'ok');
    else if (m.kind === 'run-start') busy = true;
    else if (m.kind === 'run-end') busy = false;
    else if (m.kind === 'page-snapshot' && m.snapshot) updatePageBar();
  });
  port.onDisconnect.addListener(() => { port = null; });
  port.postMessage({ kind: 'hello' });
}

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

function normalizeModel(m) {
  if (typeof m === 'string') return { id: m, label: m, provider: '', providerLabel: '' };
  return {
    ...m,
    id: String(m.id || m.model || m.name || ''),
    label: String(m.label || m.display_name || m.id || m.model || m.name || ''),
    provider: String(m.provider || m.provider_id || ''),
    providerLabel: String(m.providerLabel || m.provider_label || m.provider || '')
  };
}

function providerName(m) { return m.providerLabel || m.provider || 'Models'; }

function renderModels() {
  const select = $('modelSelect');
  const filter = $('modelFilter').value.trim().toLowerCase();
  const visible = allModels.filter((m) => !filter || `${m.id} ${m.label} ${m.provider} ${m.providerLabel}`.toLowerCase().includes(filter));
  $('modelCount').textContent = `${visible.length}/${allModels.length}`;
  select.innerHTML = '';

  if (!visible.length) {
    const option = document.createElement('option');
    option.disabled = true;
    option.textContent = 'No matching models';
    select.appendChild(option);
    return;
  }

  const groups = new Map();
  for (const m of visible) {
    const key = providerName(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  for (const [group, entries] of groups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const m of entries.sort((a, b) => a.label.localeCompare(b.label))) {
      const option = document.createElement('option');
      option.value = m.id;
      option.dataset.provider = m.provider || '';
      option.textContent = m.label || m.id;
      if (m.id === selectedModelId && (!selectedProvider || m.provider === selectedProvider)) option.selected = true;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  if (!select.value && select.options[0]) select.selectedIndex = 0;
}

async function loadModels(selected, provider) {
  selectedModelId = selected || selectedModelId;
  selectedProvider = provider || selectedProvider;
  $('modelSelect').innerHTML = '<option>Loading models…</option>';
  $('modelCount').textContent = '…';
  const r = await chrome.runtime.sendMessage({ kind: 'get-models' }).catch(() => null);
  const raw = r && r.ok ? (r.data || []) : [];
  allModels = raw.map(normalizeModel).filter((m) => m.id);
  if (!allModels.length) {
    allModels = [normalizeModel({ id: selectedModelId || 'qwen3.5-9b', provider: selectedProvider || 'lmstudio' })];
  } else if (!selectedModelId && r.default_model) {
    selectedModelId = r.default_model;
  }
  renderModels();
}

async function chooseModel() {
  const option = $('modelSelect').selectedOptions[0];
  if (!option?.value) return;
  selectedModelId = option.value;
  selectedProvider = option.dataset.provider || config?.modelProvider || '';
  await chrome.runtime.sendMessage({ kind: 'set-config', patch: {
    model: selectedModelId,
    modelProvider: selectedProvider
  }});
  config = { ...(config || {}), model: selectedModelId, modelProvider: selectedProvider };
  $('runInfo').textContent = 'model saved';
  setTimeout(() => { if (!busy) $('runInfo').textContent = ''; }, 1200);
}

async function send() {
  const text = $('prompt').value.trim();
  if (!text || busy) return;
  $('prompt').value = '';
  autoGrow();
  emptyEl.style.display = 'none';
  busy = true;
  addEl('user', text);
  setStatus('busy');
  $('runInfo').textContent = 'running…';
  try {
    const response = await chrome.runtime.sendMessage({
      kind: 'chat',
      text,
      attachPage: $('autoSnap').checked,
      model: selectedModelId || config?.model || '',
      modelProvider: selectedProvider || config?.modelProvider || ''
    });
    if (response && !response.ok) throw new Error(response.error || 'Chat request failed');
  } catch (e) {
    showError(e);
    setStatus('err');
    $('runInfo').textContent = 'error';
  }
  busy = false;
}

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
  chatEl.appendChild(emptyEl);
  emptyEl.style.display = '';
  currentStream = currentTool = null;
  await chrome.runtime.sendMessage({ kind: 'clear-thread' });
});
$('btnSnapshot').addEventListener('click', snapshotNow);
$('modelSelect').addEventListener('change', chooseModel);
$('modelFilter').addEventListener('input', renderModels);
$('refreshModels').addEventListener('click', () => loadModels(selectedModelId || config?.model, selectedProvider || config?.modelProvider));

(async () => {
  const r = await chrome.runtime.sendMessage({ kind: 'get-config' }).catch(() => null);
  if (r && r.ok) {
    config = r.config;
    selectedModelId = config.model || '';
    selectedProvider = config.modelProvider || '';
    $('autoSnap').checked = config.attachPageContext !== false;
    await loadModels(selectedModelId, selectedProvider);
  }
})();

connectPort();
updatePageBar();
console.log('[HermesPanel] ready');