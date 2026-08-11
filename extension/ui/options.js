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
$('reset').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ kind: 'set-config', patch: {
    bridgeUrl: 'http://127.0.0.1:8965', authToken: '', model: 'qwen3.5-9b',
    modelProvider: 'lmstudio', workspace: '', attachPageContext: true, enablePageActing: true
  }});
  load();
});

load();