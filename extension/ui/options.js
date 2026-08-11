// options.js — config page. Reads/writes chrome.storage via the background;
// runs a real health check against the bridge endpoint.
const $ = (id) => document.getElementById(id);

async function load() {
  const r = await chrome.runtime.sendMessage({ kind: 'get-config' });
  if (!r.ok) return;
  const c = r.config;
  $('bridgeUrl').value = c.bridgeUrl || '';
  $('authToken').value = c.authToken || '';
  $('model').value = c.model || '';
  $('modelProvider').value = c.modelProvider || '';
  $('workspace').value = c.workspace || '';
  $('attachPageContext').checked = c.attachPageContext !== false;
  $('enablePageActing').checked = c.enablePageActing !== false;
  await loadModels(c.model, c.modelProvider);
}

async function loadModels(selected, selectedProvider) {
  const select = $('model');
  select.innerHTML = '<option value="">Loading available models…</option>';
  const r = await chrome.runtime.sendMessage({ kind: 'get-models' }).catch(() => null);
  const models = r && r.ok ? (r.data || []) : [];
  if (!models.length) {
    select.innerHTML = '<option value="qwen3.5-9b">qwen3.5-9b (manual/default)</option>';
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
  const active = select.selectedOptions[0];
  if (active?.dataset.provider) $('modelProvider').value = active.dataset.provider;
}

function collect() {
  return {
    bridgeUrl: ($('bridgeUrl').value || '').replace(/\/+$/, ''),
    authToken: $('authToken').value || '',
    model: $('model').value || '',
    modelProvider: $('modelProvider').value || '',
    workspace: $('workspace').value || '',
    attachPageContext: $('attachPageContext').checked,
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
    const res = await fetch(url + '/healthz', {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      setHealth(true, `bridge up (Hermes: ${j.hermes || 'n/a'})`);
      $('testResult').textContent = JSON.stringify(j, null, 2);
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
  await chrome.runtime.sendMessage({ kind: 'set-config', patch: collect() });
  setHealth(null, 'saved');
  setTimeout(() => { setHealth(null, ''); }, 1500);
});
$('test').addEventListener('click', testConn);
$('model').addEventListener('change', () => {
  const option = $('model').selectedOptions[0];
  if (option?.dataset.provider) $('modelProvider').value = option.dataset.provider;
});
$('refreshModels').addEventListener('click', () => loadModels($('model').value, $('modelProvider').value));
$('reset').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ kind: 'set-config', patch: {
    bridgeUrl: 'http://127.0.0.1:8965', authToken: '', model: 'qwen3.5-9b',
    modelProvider: 'lmstudio', workspace: '', attachPageContext: true, enablePageActing: true
  }});
  load();
});

load();