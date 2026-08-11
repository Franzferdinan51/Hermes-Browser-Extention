// options.js — configuration and model discovery UI.
const $ = (id) => document.getElementById(id);

let allModels = [];
let selectedModelId = '';
let selectedProvider = '';

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

function looksNonChatModel(m) {
  const hay = `${m.id} ${m.label} ${m.type || ''}`.toLowerCase();
  return /(embed|embedding|rerank|reranker|whisper|speech|audio|tts|text-to-speech|transcription)/.test(hay);
}

function providerName(m) {
  return m.providerLabel || m.provider || 'Other';
}

function syncDomRange(value) {
  const n = Math.max(5000, Math.min(100000, Number(value) || 30000));
  $('maxDomChars').value = String(n);
  $('maxDomCharsNumber').value = String(n);
}

async function load() {
  const r = await chrome.runtime.sendMessage({ kind: 'get-config' });
  if (!r.ok) return;
  const c = r.config;
  $('bridgeUrl').value = c.bridgeUrl || '';
  $('authToken').value = c.authToken || '';
  $('modelProvider').value = c.modelProvider || '';
  $('workspace').value = c.workspace || '';
  $('attachPageContext').checked = c.attachPageContext !== false;
  $('enablePageActing').checked = c.enablePageActing !== false;
  syncDomRange(c.maxDomChars || 30000);
  selectedModelId = c.model || '';
  selectedProvider = c.modelProvider || '';
  await loadModels(selectedModelId, selectedProvider);
}

function rebuildProviderFilter() {
  const current = $('providerFilter').value;
  const providers = [...new Set(allModels.map(providerName))].sort((a, b) => a.localeCompare(b));
  $('providerFilter').innerHTML = '<option value="">All providers</option>';
  for (const provider of providers) {
    const option = document.createElement('option');
    option.value = provider;
    option.textContent = provider;
    $('providerFilter').appendChild(option);
  }
  if (providers.includes(current)) $('providerFilter').value = current;
}

function renderModels() {
  const search = $('modelSearch').value.trim().toLowerCase();
  const provider = $('providerFilter').value;
  const chatOnly = $('chatOnly').checked;
  const select = $('model');

  const visible = allModels.filter((m) => {
    if (provider && providerName(m) !== provider) return false;
    if (chatOnly && looksNonChatModel(m)) return false;
    if (!search) return true;
    return `${m.id} ${m.label} ${m.provider} ${m.providerLabel} ${m.type || ''}`.toLowerCase().includes(search);
  }).sort((a, b) => providerName(a).localeCompare(providerName(b)) || a.label.localeCompare(b.label));

  $('modelCount').textContent = `${visible.length} of ${allModels.length} model${allModels.length === 1 ? '' : 's'}`;
  select.innerHTML = '';

  if (!visible.length) {
    const option = document.createElement('option');
    option.disabled = true;
    option.textContent = allModels.length ? 'No models match these filters' : 'No models reported by bridge';
    select.appendChild(option);
    updateModelMeta(null);
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
    for (const m of entries) {
      const option = document.createElement('option');
      option.value = m.id;
      option.dataset.provider = m.provider || '';
      option.dataset.index = String(allModels.indexOf(m));
      option.textContent = m.label || m.id;
      if (m.id === selectedModelId && (!selectedProvider || m.provider === selectedProvider)) option.selected = true;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  if (!select.value) select.selectedIndex = 0;
  const active = select.selectedOptions[0];
  if (active) {
    selectedModelId = active.value;
    if (active.dataset.provider) selectedProvider = active.dataset.provider;
    $('modelProvider').value = selectedProvider || $('modelProvider').value;
    updateModelMeta(modelFromOption(active));
  }
}

function modelFromOption(option) {
  const i = Number(option?.dataset.index);
  return Number.isInteger(i) && i >= 0 ? allModels[i] : allModels.find((m) => m.id === option?.value) || null;
}

function updateModelMeta(m) {
  const el = $('modelMeta');
  if (!m) {
    el.innerHTML = '<span>Select a model to see its details.</span>';
    return;
  }
  const fields = [
    `<span><strong>${escapeHtml(m.label || m.id)}</strong></span>`,
    `<span>${escapeHtml(providerName(m))}</span>`
  ];
  if (m.type) fields.push(`<span>${escapeHtml(String(m.type))}</span>`);
  if (m.context_length || m.contextLength) fields.push(`<span>${Number(m.context_length || m.contextLength).toLocaleString()} ctx</span>`);
  if (m.owned_by) fields.push(`<span>${escapeHtml(String(m.owned_by))}</span>`);
  fields.push(`<span class="code">${escapeHtml(m.id)}</span>`);
  el.innerHTML = fields.join('');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

async function loadModels(selected, provider) {
  selectedModelId = selected || selectedModelId;
  selectedProvider = provider || selectedProvider;
  $('model').innerHTML = '<option value="">Loading available models…</option>';
  $('modelCount').textContent = 'loading…';
  const r = await chrome.runtime.sendMessage({ kind: 'get-models' }).catch(() => null);
  const raw = r && r.ok ? (r.data || []) : [];
  allModels = raw.map(normalizeModel).filter((m) => m.id);

  if (!allModels.length) {
    allModels = [normalizeModel({ id: selectedModelId || 'qwen3.5-9b', label: `${selectedModelId || 'qwen3.5-9b'} (manual/default)`, provider: selectedProvider || 'lmstudio' })];
    $('modelSource').textContent = 'fallback';
    $('modelSource').className = 'pill warn';
  } else {
    $('modelSource').textContent = 'live';
    $('modelSource').className = 'pill ok';
    if (!selectedModelId && r.default_model) selectedModelId = r.default_model;
  }

  rebuildProviderFilter();
  renderModels();
}

function collect() {
  return {
    bridgeUrl: ($('bridgeUrl').value || '').replace(/\/+$/, ''),
    authToken: $('authToken').value || '',
    model: selectedModelId || $('model').value || '',
    modelProvider: $('modelProvider').value || selectedProvider || '',
    workspace: $('workspace').value || '',
    attachPageContext: $('attachPageContext').checked,
    autoSnapshot: false,
    maxDomChars: Number($('maxDomCharsNumber').value) || 30000,
    enablePageActing: $('enablePageActing').checked
  };
}

function setHealth(ok, text) {
  const pill = $('healthPill');
  pill.className = 'pill ' + (ok ? 'ok' : ok === false ? 'err' : 'warn');
  pill.textContent = ok === null ? 'unknown' : ok ? 'connected' : 'error';
  $('health').textContent = text;
}

async function testConn() {
  $('testResult').textContent = 'Testing…';
  setHealth(null, 'checking bridge');
  const url = $('bridgeUrl').value.replace(/\/+$/, '') || 'http://127.0.0.1:8965';
  const token = $('authToken').value || '';
  try {
    const res = await fetch(url + '/healthz', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      setHealth(true, `bridge up · Hermes ${j.hermes || 'n/a'}`);
      $('testResult').textContent = JSON.stringify(j, null, 2);
      await chrome.runtime.sendMessage({ kind: 'set-config', patch: { bridgeUrl: url, authToken: token } });
      await loadModels(selectedModelId, selectedProvider);
    } else {
      setHealth(false, `HTTP ${res.status}`);
      $('testResult').textContent = await res.text();
    }
  } catch (e) {
    setHealth(false, e.message);
    $('testResult').textContent = `Could not reach ${url}. Is the bridge running?\n\n${e.message}`;
  }
}

$('save').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ kind: 'set-config', patch: collect() });
  $('saveState').textContent = r?.ok ? 'Saved locally.' : `Save failed: ${r?.error || 'unknown error'}`;
  setHealth(null, r?.ok ? 'saved' : 'save failed');
  setTimeout(() => { if (r?.ok) setHealth(null, ''); }, 1500);
});

$('test').addEventListener('click', testConn);
$('refreshModels').addEventListener('click', () => loadModels(selectedModelId, selectedProvider));
$('modelSearch').addEventListener('input', renderModels);
$('providerFilter').addEventListener('change', renderModels);
$('chatOnly').addEventListener('change', renderModels);
$('model').addEventListener('change', () => {
  const option = $('model').selectedOptions[0];
  if (!option || !option.value) return;
  selectedModelId = option.value;
  selectedProvider = option.dataset.provider || selectedProvider;
  if (option.dataset.provider) $('modelProvider').value = option.dataset.provider;
  updateModelMeta(modelFromOption(option));
});
$('toggleToken').addEventListener('click', () => {
  const input = $('authToken');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('toggleToken').textContent = showing ? 'Show' : 'Hide';
});
$('maxDomChars').addEventListener('input', (e) => syncDomRange(e.target.value));
$('maxDomCharsNumber').addEventListener('change', (e) => syncDomRange(e.target.value));
$('reset').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ kind: 'set-config', patch: {
    bridgeUrl: 'http://127.0.0.1:8965', authToken: '', model: 'qwen3.5-9b', modelProvider: 'lmstudio',
    workspace: '', attachPageContext: true, autoSnapshot: false, maxDomChars: 30000, enablePageActing: true
  }});
  $('modelSearch').value = '';
  $('providerFilter').value = '';
  $('chatOnly').checked = false;
  await load();
  $('saveState').textContent = 'Defaults restored.';
});

load();