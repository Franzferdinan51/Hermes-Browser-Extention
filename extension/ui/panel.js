// panel.js — Hermes side panel client. Renders AG-UI responses, runtime state,
// browser tool calls/results, page context, Hermes toolsets/skills, and models.
import { readThreadId, buildChatRequest } from '../lib/thread.js';
import { abortSucceeded, shouldIdleComposer } from '../lib/agui-client.js';

const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const emptyEl = $('empty');

let port = null;
let busy = false;
let liveSend = 0;
let config = null;
let allModels = [];
let selectedModelId = '';
let selectedProvider = '';
let bridgeConnected = false;
let currentStream = null;
let runtimeData = null;
let threadId = '';
const toolCards = new Map();
const pendingToolResults = new Map();

function scrollChat() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function addEl(cls, text) {
  emptyEl.style.display = 'none';
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  chatEl.appendChild(d);
  scrollChat();
  return d;
}

// ---------------------------------------------------------------------------
// Safe lightweight response rendering
// ---------------------------------------------------------------------------
function appendInline(parent, text) {
  const source = String(text || '');
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > last) parent.appendChild(document.createTextNode(source.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.className = 'md-inline-code';
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (linkMatch) {
        const a = document.createElement('a');
        a.href = linkMatch[2];
        a.textContent = linkMatch[1];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(token));
      }
    }
    last = pattern.lastIndex;
  }
  if (last < source.length) parent.appendChild(document.createTextNode(source.slice(last)));
}

function renderRichText(container, text) {
  container.textContent = '';
  const lines = String(text || '').split('\n');
  let inCode = false;
  let codeLines = [];
  let codeLanguage = '';
  let list = null;

  const flushList = () => { list = null; };
  const flushCode = () => {
    const pre = document.createElement('pre');
    pre.className = 'md-code';
    const code = document.createElement('code');
    if (codeLanguage) code.dataset.language = codeLanguage;
    code.textContent = codeLines.join('\n');
    pre.appendChild(code);
    container.appendChild(pre);
    codeLines = [];
    codeLanguage = '';
  };

  for (const line of lines) {
    const fence = line.match(/^```\s*([^\s`]*)/);
    if (fence) {
      if (inCode) flushCode();
      else codeLanguage = fence[1] || '';
      inCode = !inCode;
      flushList();
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushList();
      const h = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      h.className = 'md-heading';
      appendInline(h, heading[2]);
      container.appendChild(h);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!list) {
        list = document.createElement('ul');
        list.className = 'md-list';
        container.appendChild(list);
      }
      const li = document.createElement('li');
      appendInline(li, bullet[1]);
      list.appendChild(li);
      continue;
    }

    flushList();
    if (!line.trim()) {
      const spacer = document.createElement('div');
      spacer.className = 'md-spacer';
      container.appendChild(spacer);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    const row = document.createElement(quote ? 'blockquote' : 'div');
    row.className = quote ? 'md-quote' : 'md-line';
    appendInline(row, quote ? quote[1] : line);
    container.appendChild(row);
  }
  if (inCode) flushCode();
}

function openAssistant() {
  emptyEl.style.display = 'none';
  const d = document.createElement('div');
  d.className = 'msg assistant streaming';
  const body = document.createElement('div');
  body.className = 'assistant-body';
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '▋';
  body.appendChild(caret);
  d.appendChild(body);
  chatEl.appendChild(d);
  scrollChat();
  return { el: d, body, caret, text: '' };
}

function appendStream(text) {
  if (!currentStream) currentStream = openAssistant();
  const delta = String(text || '');
  currentStream.text += delta;
  if (currentStream.caret.parentNode) currentStream.caret.remove();
  currentStream.body.appendChild(document.createTextNode(delta));
  currentStream.body.appendChild(currentStream.caret);
  scrollChat();
}

function addMessageActions(stream) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copy = document.createElement('button');
  copy.className = 'copy-msg';
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.title = 'Copy response';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(stream.text);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    } catch {
      copy.textContent = 'Copy failed';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    }
  });
  actions.appendChild(copy);
  stream.el.appendChild(actions);
}

function finalizeStream() {
  if (!currentStream) return;
  if (currentStream.caret.parentNode) currentStream.caret.remove();
  currentStream.el.classList.remove('streaming');
  renderRichText(currentStream.body, currentStream.text);
  addMessageActions(currentStream);
  currentStream = null;
}

// ---------------------------------------------------------------------------
// Tool timeline
// ---------------------------------------------------------------------------
function prettyValue(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function openTool(name, toolCallId) {
  const id = toolCallId || `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (toolCards.has(id)) return toolCards.get(id);

  emptyEl.style.display = 'none';
  const details = document.createElement('details');
  details.className = 'msg tool pending';

  const summary = document.createElement('summary');
  summary.className = 'toolhead';
  const label = document.createElement('span');
  label.className = 'tool-label';
  label.textContent = `🧰 ${name || 'tool'}`;
  const status = document.createElement('span');
  status.className = 'tool-status';
  status.textContent = 'running';
  summary.append(label, status);

  const args = document.createElement('pre');
  args.className = 'toolargs';
  details.append(summary, args);
  chatEl.appendChild(details);
  scrollChat();

  const card = { id, el: details, argsEl: args, statusEl: status, name: name || 'tool', args: '' };
  toolCards.set(id, card);
  const pending = pendingToolResults.get(id);
  if (pending) {
    pendingToolResults.delete(id);
    finalizeTool(id, pending.ok, pending.value);
  }
  return card;
}

function appendToolArgs(toolCallId, delta) {
  let card = toolCards.get(toolCallId);
  if (!card) card = openTool('tool', toolCallId);
  card.args += String(delta || '');
  card.argsEl.textContent = card.args;
  scrollChat();
}

function finalizeTool(toolCallId, resultOk, resultValue) {
  let card = toolCards.get(toolCallId);
  if (!card && toolCards.size === 1) card = [...toolCards.values()][0];
  if (!card) {
    if (toolCallId) pendingToolResults.set(toolCallId, { ok: resultOk, value: resultValue });
    return;
  }

  card.el.classList.remove('pending');
  card.el.classList.add(resultOk === false ? 'err' : 'ok');
  card.statusEl.textContent = resultOk === false ? 'failed' : 'done';

  const resultText = prettyValue(resultValue);
  if (resultText) {
    let result = card.el.querySelector('.toolresult');
    if (!result) {
      result = document.createElement('pre');
      result.className = 'toolresult';
      card.el.appendChild(result);
    }
    result.textContent = resultText.slice(0, 4000);
  }
}

function finalizeOpenTools(ok = true, value = '') {
  for (const card of toolCards.values()) {
    if (card.el.classList.contains('pending')) finalizeTool(card.id, ok, value);
  }
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

function flushText() {
  if (!pendingText) return;
  if (textTimer) clearTimeout(textTimer);
  textTimer = null;
  appendStream(pendingText);
  pendingText = '';
}

let lastRenderedError = '';
function showError(value) {
  const raw = value instanceof Error ? value.message : String(value || 'unknown');
  const normalized = raw.replace(/^Error:\s*/i, '');
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

// ---------------------------------------------------------------------------
// Runtime/status
// ---------------------------------------------------------------------------
function runLabel(label) {
  $('runInfo').textContent = label || '';
}

function contextLabel(data = {}) {
  const direct = data.percent ?? data.percentage ?? data.context_percent ?? data.contextPercent;
  if (Number.isFinite(Number(direct))) return `context ${Math.round(Number(direct))}%`;
  const used = Number(data.used_tokens ?? data.usedTokens ?? data.tokens_used);
  const max = Number(data.max_tokens ?? data.maxTokens ?? data.context_window);
  if (Number.isFinite(used) && Number.isFinite(max) && max > 0) return `context ${Math.round((used / max) * 100)}%`;
  return '';
}

function meteringLabel(data = {}) {
  const total = data.total_tokens ?? data.totalTokens ?? data.tokens;
  if (Number.isFinite(Number(total))) return `${Number(total).toLocaleString()} tokens`;
  const input = Number(data.input_tokens ?? data.inputTokens);
  const output = Number(data.output_tokens ?? data.outputTokens);
  if (Number.isFinite(input) || Number.isFinite(output)) return `${(input || 0) + (output || 0)} tokens`;
  return '';
}

function runtimeChip(text, title = '', state = '') {
  const chip = document.createElement('span');
  chip.className = `runtime-chip${state ? ` ${state}` : ''}`;
  chip.textContent = text;
  if (title) chip.title = title;
  return chip;
}

function renderRuntime(runtime) {
  if (!runtime) return;
  runtimeData = runtime;
  const toolsets = Array.isArray(runtime.toolsets) ? runtime.toolsets : [];
  const skills = Array.isArray(runtime.skills) ? runtime.skills : [];
  const enabledToolsets = toolsets.filter((row) => row?.enabled !== false);
  const enabledSkills = skills.filter((row) => row?.enabled !== false);
  const summary = runtime.summary || {};
  const toolCount = Number.isFinite(Number(summary.tools))
    ? Number(summary.tools)
    : enabledToolsets.reduce((sum, row) => sum + (Array.isArray(row?.tools) ? row.tools.length : 0), 0);

  const companionRow = toolsets.find((row) => row?.name === 'companion') || enabledToolsets.find((row) => row?.companion);
  const companionList = Array.isArray(companionRow?.tools) ? companionRow.tools : [];
  const companionTools = companionList.length || Number(summary.companionTools) || 0;
  $('runtimeSummary').textContent = `${enabledToolsets.length} sets · ${toolCount} tools · ${companionTools} companion · ${enabledSkills.length} skills`;
  $('runtimeSkillCount').textContent = enabledSkills.length ? `${enabledSkills.length} enabled` : 'none';
  if ($('companionCount')) $('companionCount').textContent = companionTools ? `${companionTools} mirrored` : 'none';

  const toolsetRoot = $('runtimeToolsets');
  toolsetRoot.textContent = '';
  if (!enabledToolsets.length) {
    toolsetRoot.appendChild(runtimeChip('No enabled toolsets', '', 'warn'));
  } else {
    for (const row of enabledToolsets.sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)))) {
      if (row.name === 'companion') continue;
      const tools = Array.isArray(row.tools) ? row.tools : [];
      const label = row.label || row.name || 'toolset';
      const configured = row.configured === false ? ' · needs configuration' : '';
      const title = `${row.description || row.name || label}\n${tools.length} tools${configured}${tools.length ? `\n\n${tools.join('\n')}` : ''}`;
      toolsetRoot.appendChild(runtimeChip(`${label} · ${tools.length}`, title, row.configured === false ? 'warn' : 'ok'));
    }
  }

  const companionRoot = $('runtimeCompanion');
  if (companionRoot) {
    companionRoot.textContent = '';
    if (!companionList.length) {
      companionRoot.appendChild(runtimeChip('Companion catalog unavailable', '', 'warn'));
    } else {
      for (const name of companionList.slice(0, 80)) {
        companionRoot.appendChild(runtimeChip(String(name).replace(/^browser_/, ''), String(name), 'ok'));
      }
      if (companionList.length > 80) companionRoot.appendChild(runtimeChip(`+${companionList.length - 80} more`, 'Additional companion actions are hidden from this compact view.'));
    }
  }

  const skillRoot = $('runtimeSkills');
  skillRoot.textContent = '';
  if (!enabledSkills.length) {
    skillRoot.appendChild(runtimeChip('No enabled skills', '', 'warn'));
  } else {
    const sortedSkills = enabledSkills.sort((a, b) => {
      const au = Number(a.usage || 0);
      const bu = Number(b.usage || 0);
      return bu - au || String(a.name || '').localeCompare(String(b.name || ''));
    });
    for (const skill of sortedSkills.slice(0, 60)) {
      const provenance = skill.provenance ? ` · ${skill.provenance}` : '';
      const usage = Number(skill.usage || 0) > 0 ? ` · used ${Number(skill.usage).toLocaleString()}` : '';
      skillRoot.appendChild(runtimeChip(skill.name || 'skill', `${skill.description || skill.name || 'Hermes skill'}${provenance}${usage}`, skill.provenance === 'agent' ? 'agent' : ''));
    }
    if (sortedSkills.length > 60) skillRoot.appendChild(runtimeChip(`+${sortedSkills.length - 60} more`, 'Additional enabled skills are hidden from this compact view.'));
  }

  const errors = Array.isArray(runtime.errors) ? runtime.errors : [];
  const errorRoot = $('runtimeErrors');
  if (errors.length) {
    errorRoot.hidden = false;
    errorRoot.textContent = errors.map((e) => `${e.resource || 'runtime'}: ${e.error || 'unavailable'}`).join('\n');
  } else {
    errorRoot.hidden = true;
    errorRoot.textContent = '';
  }
}

async function loadRuntime(refresh = false) {
  $('runtimeSummary').textContent = refresh ? 'refreshing…' : 'loading…';
  const response = await chrome.runtime.sendMessage({ kind: 'get-runtime', refresh }).catch(() => null);
  if (response?.ok) {
    renderRuntime(response);
    return;
  }
  $('runtimeSummary').textContent = 'unavailable';
  const errorRoot = $('runtimeErrors');
  errorRoot.hidden = false;
  errorRoot.textContent = response?.error || 'Hermes runtime metadata is unavailable on this bridge/runtime.';
}

function handleCustom(e) {
  if (e.kind === 'tool-result') {
    finalizeTool(e.toolCallId, e.ok !== false, e.value ?? e.result ?? e.error);
    return;
  }
  if (e.kind === 'agent-status') {
    runLabel(e.label || e.phase || 'working…');
    if (e.phase === 'done') setStatus('ok');
    else setStatus('busy');
    return;
  }
  if (e.kind === 'context-status') {
    const label = contextLabel(e.data || {});
    if (label) runLabel(label);
    return;
  }
  if (e.kind === 'metering') {
    const label = meteringLabel(e.data || {});
    if (label && !busy) runLabel(label);
  }
}

function handleEvent(e, sendToken) {
  const t = e.type;
  switch (t) {
    case 'RUN_STARTED':
      setComposerBusy(true, 'Thinking…');
      threadId = readThreadId(e) || threadId;
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
      openTool(toolNameFromEvent(e), e.toolCallId || e.id);
      break;
    case 'TOOL_CALL_ARGS':
      appendToolArgs(e.toolCallId || e.id, e.delta || '');
      break;
    case 'TOOL_CALL_CHUNK':
      appendToolArgs(e.toolCallId || e.id, e.args || e.delta || '');
      break;
    case 'TOOL_CALL_END': {
      const card = toolCards.get(e.toolCallId || e.id);
      if (card) card.statusEl.textContent = 'waiting';
      break;
    }
    case 'tool-result':
      finalizeTool(e.toolCallId || e.id, e.ok !== false, e.value ?? e.error);
      break;
    case 'CUSTOM':
      handleCustom(e);
      break;
    case 'STATE_SNAPSHOT':
    case 'MESSAGES_SNAPSHOT':
      break;
    case 'RUN_FINISHED':
      flushText();
      finalizeStream();
      finalizeOpenTools(true);
      idleComposer(sendToken, 'done');
      setTimeout(() => { if (!busy) runLabel(''); }, 1400);
      break;
    case 'RUN_ERROR':
      flushText();
      finalizeStream();
      finalizeOpenTools(false, e.error || e.message);
      idleComposer(sendToken, 'error');
      showError(e.error || e.message || 'unknown');
      break;
    default:
      break;
  }
}

function setComposerBusy(on, label) {
  busy = !!on;
  const sendBtn = $('send');
  const stopBtn = $('btnStop');
  if (sendBtn) sendBtn.hidden = busy;
  if (stopBtn) stopBtn.hidden = !busy;
  setStatus(busy ? 'busy' : (bridgeConnected ? 'ok' : 'err'));
  if (label !== undefined) runLabel(label);
}

function idleComposer(sendToken, label) {
  if (shouldIdleComposer(sendToken, liveSend)) setComposerBusy(false, label);
}

async function stopRun() {
  if (!busy) return;
  const sendToken = liveSend;
  runLabel('Stopping…');
  const response = await chrome.runtime.sendMessage({ kind: 'abort-run' }).catch(() => null);
  if (!abortSucceeded(response)) {
    runLabel('still running');
    return;
  }
  flushText();
  finalizeStream();
  finalizeOpenTools(false, 'stopped');
  idleComposer(sendToken, 'stopped');
}

function setStatus(state) {
  const el = $('phStatus');
  el.className = 'ph-status ' + state;
  el.title = state === 'ok'
    ? 'Hermes bridge connected'
    : state === 'busy'
      ? 'Hermes is working'
      : 'Hermes bridge unavailable';
}

function connectPort() {
  try { port = chrome.runtime.connect({ name: 'panel' }); } catch { return; }
  port.onMessage.addListener((m) => {
    if (m.kind === 'event' && m.event) handleEvent(m.event, m.sendToken);
    else if (m.kind === 'state') {
      bridgeConnected = Boolean(m.bridgeConnected);
      setStatus(m.clientBusy ? 'busy' : bridgeConnected ? 'ok' : 'err');
      if (m.runtime) renderRuntime(m.runtime);
      if (m.threadId) threadId = m.threadId;
    } else if (m.kind === 'run-start') {
      setComposerBusy(true, 'Thinking…');
    } else if (m.kind === 'run-end') {
      if (shouldIdleComposer(m.sendToken, liveSend)) {
        if (m.aborted) {
          flushText();
          finalizeStream();
          finalizeOpenTools(false, 'stopped');
          idleComposer(m.sendToken, 'stopped');
        } else {
          idleComposer(m.sendToken, m.ok === false ? 'error' : 'done');
        }
      }
    } else if (m.kind === 'page-snapshot' && m.snapshot) {
      updatePageBar();
    } else if (m.kind === 'page-context-status') {
      if (m.ok) {
        if (m.thin) runLabel(`Weak page read · ${m.words || 0} words${m.posts ? ` · ${m.posts} posts` : ''}`);
        else runLabel(`Pinned to this tab · ${m.interactive || 0} controls${m.posts ? ` · ${m.posts} posts` : ''}`);
        if (m.title || m.url) {
          $('pageTitle').textContent = m.title || m.url;
          $('pageTitle').title = m.url || '';
        }
      } else runLabel(m.error || 'Page context unavailable');
    } else if (m.kind === 'bridge-status') {
      bridgeConnected = Boolean(m.connected);
      if (!busy) setStatus(bridgeConnected ? 'ok' : 'err');
      if (bridgeConnected && !runtimeData) loadRuntime().catch(() => {});
    } else if (m.kind === 'agent-state' && m.phase && busy) {
      if (m.phase === 'running') runLabel('Thinking…');
    } else if (m.kind === 'runtime' && m.runtime) {
      renderRuntime(m.runtime);
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    bridgeConnected = false;
    if (!busy) setStatus('err');
  });
  port.postMessage({ kind: 'hello' });
}

async function updatePageBar() {
  const r = await chrome.runtime.sendMessage({ kind: 'get-state' }).catch(() => null);
  const snap = r?.snapshot;
  if (r) {
    bridgeConnected = Boolean(r.bridgeConnected);
    if (!busy) setStatus(bridgeConnected ? 'ok' : 'err');
    if (r.runtime) renderRuntime(r.runtime);
    if (r.threadId) threadId = r.threadId;
  }
  if (snap) {
    $('pageTitle').textContent = snap.snapshot?.title || snap.title || snap.url || '—';
    $('pageTitle').title = snap.url || '';
  }
}

async function snapshotNow() {
  runLabel('Reading page…');
  const r = await chrome.runtime.sendMessage({ kind: 'read-page' }).catch(() => null);
  if (r?.ok) {
    await updatePageBar();
    runLabel('snapshot ready');
  } else {
    runLabel('snapshot failed');
  }
  setTimeout(() => { if (!busy) runLabel(''); }, 1200);
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
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

function providerName(m) {
  return m.providerLabel || m.provider || 'Models';
}

function renderModels() {
  const select = $('modelSelect');
  const filter = $('modelFilter')?.value.trim().toLowerCase() || '';
  const visible = allModels.filter((m) => !filter || `${m.id} ${m.label} ${m.provider} ${m.providerLabel}`.toLowerCase().includes(filter));
  if ($('modelCount')) $('modelCount').textContent = `${visible.length}/${allModels.length}`;
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
  if ($('modelCount')) $('modelCount').textContent = '…';
  const r = await chrome.runtime.sendMessage({ kind: 'get-models' }).catch(() => null);
  const raw = r?.ok ? (r.data || []) : [];
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
  runLabel('model saved');
  setTimeout(() => { if (!busy) runLabel(''); }, 1200);
}

async function send() {
  const text = $('prompt').value.trim();
  if (!text || busy) return;
  const sendToken = ++liveSend;
  $('prompt').value = '';
  autoGrow();
  emptyEl.style.display = 'none';
  setComposerBusy(true, 'Thinking…');
  addEl('user', text);
  try {
    const response = await chrome.runtime.sendMessage(buildChatRequest(text, { threadId }, {
      attachPage: $('autoSnap').checked,
      model: selectedModelId || config?.model || '',
      modelProvider: selectedProvider || config?.modelProvider || '',
      sendToken
    }));
    if (response?.aborted) {
      idleComposer(sendToken, 'stopped');
      return;
    }
    if (response && !response.ok) throw new Error(response.error || 'Chat request failed');
  } catch (e) {
    if (/abort/i.test(String(e?.message || e))) {
      idleComposer(sendToken, 'stopped');
      return;
    }
    showError(e);
    idleComposer(sendToken, 'error');
  } finally {
    if (shouldIdleComposer(sendToken, liveSend)) setComposerBusy(false);
  }
}

$('send').addEventListener('click', send);
$('btnStop').addEventListener('click', stopRun);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
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
  currentStream = null;
  toolCards.clear();
  pendingToolResults.clear();
  pendingText = '';
  if (textTimer) clearTimeout(textTimer);
  textTimer = null;
  threadId = '';
  await chrome.runtime.sendMessage({ kind: 'clear-thread' });
  runLabel('new session');
  setTimeout(() => runLabel(''), 900);
});
$('btnSnapshot').addEventListener('click', snapshotNow);
$('refreshRuntime').addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  loadRuntime(true).catch(() => {});
});
$('modelSelect').addEventListener('change', chooseModel);
$('autoSnap').addEventListener('change', async () => {
  const attachPageContext = $('autoSnap').checked;
  config = { ...(config || {}), attachPageContext };
  await chrome.runtime.sendMessage({ kind: 'set-config', patch: { attachPageContext } }).catch(() => null);
});
if ($('modelFilter')) $('modelFilter').addEventListener('input', renderModels);
$('refreshModels').addEventListener('click', () => loadModels(selectedModelId || config?.model, selectedProvider || config?.modelProvider));

(async () => {
  const r = await chrome.runtime.sendMessage({ kind: 'get-config' }).catch(() => null);
  if (r?.ok) {
    config = r.config;
    selectedModelId = config.model || '';
    selectedProvider = config.modelProvider || '';
    $('autoSnap').checked = config.attachPageContext !== false;
    if (globalThis.HermesTheme) HermesTheme.apply(config);
    await Promise.all([
      loadModels(selectedModelId, selectedProvider),
      loadRuntime(true)
    ]);
  }
})();

connectPort();
updatePageBar();
console.log('[HermesPanel] ready');