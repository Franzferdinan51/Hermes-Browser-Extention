/**
 * server.mjs — Hermes ⇄ AG-UI bridge.
 *
 * Endpoints:
 *   POST /agent          AG-UI SSE agent endpoint
 *   GET  /healthz        bridge + Hermes reachability
 *   GET  /v1/models      configured Hermes model inventory
 *   GET  /v1/runtime     read-only Hermes toolset + skill inventory
 *   WS   /ws             correlated active-tab browser action channel
 *   POST /tool-result    alternate browser-result channel
 *
 * Security:
 *   - binds only to 127.0.0.1
 *   - accepts browser-origin requests only from extension origins
 *   - optional BRIDGE_AUTH_TOKEN protects HTTP + WebSocket routes
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { HermesClient, readSSE } from './hermes.mjs';

function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) {
    console.warn('[hermes-bridge] could not load ' + file + ': ' + e.message);
  }
}

const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
loadEnvFile(path.join(HERMES_HOME, '.hermes-webui.env'));

const PORT = Number(process.env.PORT || 8965);
const cfg = {
  hermesUrl: process.env.HERMES_URL || `http://127.0.0.1:${process.env.HERMES_WEBUI_PORT || 8787}`,
  password: process.env.HERMES_PASSWORD || process.env.HERMES_WEBUI_PASSWORD || '',
  model: process.env.MODEL || 'qwen3.5-9b',
  modelProvider: process.env.MODEL_PROVIDER || 'lmstudio',
  workspace: process.env.WORKSPACE || '',
  authToken: process.env.BRIDGE_AUTH_TOKEN || ''
};

const hermes = new HermesClient({
  baseUrl: cfg.hermesUrl,
  password: cfg.password,
  model: cfg.model,
  modelProvider: cfg.modelProvider,
  workspace: cfg.workspace
});
const hermesSessions = new Map();
const MAX_THREAD_STATE = 32;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function sessionIdForThread(threadId, model, provider) {
  const row = hermesSessions.get(threadId);
  if (!row) return undefined;
  if (typeof row === 'string') return row;
  const sameModel = !model || !row.model || String(row.model) === String(model);
  const sameProvider = !provider || !row.provider || String(row.provider) === String(provider);
  return sameModel && sameProvider ? row.sessionId : undefined;
}

function rememberThread(map, key, value) {
  if (!key) return;
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_THREAD_STATE) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

async function readRequestBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('request_too_large');
      error.code = 'request_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Request security
// ---------------------------------------------------------------------------
function isAllowedOrigin(origin = '') {
  if (!origin) return true; // curl/node/native clients do not send Origin.
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(origin)
    || /^moz-extension:\/\/[a-z0-9-]+$/i.test(origin);
}

function tokenFromRequest(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  if (bearer) return bearer;
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function sameToken(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAuthorized(req) {
  return !cfg.authToken || sameToken(tokenFromRequest(req), cfg.authToken);
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// WebSocket channel to the extension
// ---------------------------------------------------------------------------
const wsClients = new Set();
const pendingToolResults = new Map();
const mirrorStreams = new Map();
const threadMirrorResults = new Map();
const threadAttachPins = new Map();

function wsSend(obj) {
  let sent = 0;
  for (const client of wsClients) {
    try {
      if (client.readyState === 1) {
        client.send(JSON.stringify(obj));
        sent++;
      }
    } catch {}
  }
  return sent;
}

function waitToolResult(requestId, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingToolResults.delete(requestId);
      resolve({ ok: false, error: 'timed out waiting for browser action result' });
    }, timeoutMs);
    pendingToolResults.set(requestId, { resolve, timer });
  });
}

function resolveToolResult(payload = {}) {
  let requestId = payload.requestId || payload.request_id || '';
  if (!requestId && pendingToolResults.size === 1) requestId = pendingToolResults.keys().next().value;
  if (!requestId) return false;
  const pending = pendingToolResults.get(requestId);
  const mirror = mirrorStreams.get(requestId);
  if (!pending && !mirror) return false;
  if (pending) {
    clearTimeout(pending.timer);
    pendingToolResults.delete(requestId);
    pending.resolve(payload.result || payload);
  }
  if (mirror) {
    mirrorStreams.delete(requestId);
    const history = threadMirrorResults.get(mirror.threadId) || [];
    history.push({
      requestId,
      toolCallId: mirror.toolCallId,
      toolName: mirror.toolName,
      ok: payload.result?.ok !== false,
      result: payload.result || payload,
      timestamp: Date.now()
    });
    rememberThread(threadMirrorResults, mirror.threadId, history.slice(-8));
    if (!mirror.res.writableEnded) {
      mirror.res.write(sse(custom('tool-result', {
        requestId,
        toolCallId: mirror.toolCallId,
        ok: payload.result?.ok !== false,
        result: payload.result || payload
      })));
    }
  }
  return true;
}

function isSafeNavUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^[a-zA-Z][a-zA-Z+\-.]*:/.test(raw)) return /^https?:\/\//i.test(raw);
  if (raw.startsWith('//')) return false;
  return true;
}

function actionReadyToMirror(action) {
  if (!action?.name) return false;
  const params = action.params || {};
  const needsTarget = new Set([
    'click', 'set_value', 'type_into', 'check', 'uncheck', 'clear', 'hover',
    'focus', 'select_option', 'read', 'fill_many', 'drag', 'hold_click',
    'dblclick', 'right_click', 'attrs', 'scroll_into_view', 'visible', 'highlight'
  ]);
  if (action.name === 'navigate') return isSafeNavUrl(params.url);
  if (action.name === 'tabs') {
    const verb = String(params.action || 'list').toLowerCase();
    if (/^(create|new|open|new_page)$/.test(verb) && params.url) return isSafeNavUrl(params.url);
  }
  if (action.name === 'windows') {
    const verb = String(params.action || 'list').toLowerCase();
    if (/^(create|new)$/.test(verb) && params.url) return isSafeNavUrl(params.url);
  }
  if (action.name === 'key') return Boolean(params.keys);
  if (action.name === 'grep' || action.name === 'find') return Boolean(params.pattern);
  if (action.name === 'evaluate') return Boolean(params.expression);
  if (action.name === 'run') return Array.isArray(params.actions) && params.actions.length > 0;
  if (action.name === 'fill_many') return Array.isArray(params.fields) && params.fields.length > 0;
  if (action.name === 'drag') return Boolean(params.ref && params.targetRef);
  if (action.name === 'click_at' || action.name === 'hover_at') {
    return Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y));
  }
  if (needsTarget.has(action.name)) return Boolean(params.selector);
  return true;
}

function attachPin(input = {}, threadId = input.threadId) {
  const pageContext = (input.context || []).find((ctx) => ctx.type === 'page_context' || ctx.document);
  const remembered = threadId ? threadAttachPins.get(threadId) : null;
  const fromInput = Boolean(input.attachPage || pageContext || input.attachedTab);
  const pin = {
    attached: fromInput || Boolean(remembered),
    tabId: pageContext?.tabId ?? input.attachedTab?.id ?? remembered?.tabId ?? null,
    url: pageContext?.url || input.attachedTab?.url || remembered?.url || '',
    title: pageContext?.title || input.attachedTab?.title || remembered?.title || ''
  };
  if (pin.attached && threadId) rememberThread(threadAttachPins, threadId, { tabId: pin.tabId, url: pin.url, title: pin.title });
  return pin;
}

function workingBrowserBlock(pin) {
  const where = [
    pin.tabId != null ? `tab #${pin.tabId}` : 'the attached tab',
    pin.url || '',
    pin.title || ''
  ].filter(Boolean).join(' · ');
  return (
    `[WORKING BROWSER]\n` +
    `You are already inside the user's real Chrome (${where || 'attached tab'}). That Chrome window is your workspace.\n` +
    `Sandbox: stay in this Chrome profile. Do not open Hermes' internal browser, Playwright, a headless browser, Browserbase, or any other browser.\n` +
    `Default: read and click on the attached tab.\n` +
    `If the user asks to open a tab, a link, or another page, do it in THIS Chrome with browser_tabs(action=create, url=https://...) or browser_navigate. New tabs here are allowed.\n` +
    `Do not call web_search or web_extract just to re-read this page. Do not call browser_exec.\n` +
    `If you need more of THIS page, use browser_snapshot, browser_page_content, browser_read, browser_scroll, browser_grep, browser_click, or browser_type.`
  );
}

function lastUserText(input = {}) {
  const messages = input.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = String(messages[i]?.role || '').toLowerCase();
    if (role === 'user') {
      const content = messages[i].content;
      return typeof content === 'string' ? content : JSON.stringify(content || '');
    }
  }
  return '';
}

function userAskedToLeaveAttachedTab(input = {}) {
  return /\b(search the web|search online|google this|look(?:\s+it)?\s+up online|leave this (?:tab|page)|in another browser|use (?:hermes'?|the) (?:internal |headless )?browser)\b/i
    .test(lastUserText(input));
}

function userAskedForChromeWorkspace(input = {}) {
  return /\b(open (?:a |the |this |that )?(?:new )?(?:tab|window)|new tab|another tab|sibling tab|in (?:a )?(?:new )?tab|in this (?:chrome|browser)|attached browser|open (?:the )?(?:link|article|url|page)|go to https?:\/\/|navigate to|browse to|visit https?:\/\/|take me to|open https?:\/\/)\b/i
    .test(lastUserText(input));
}

function userAllowsChromeNavigation(input = {}) {
  return userAskedToLeaveAttachedTab(input) || userAskedForChromeWorkspace(input);
}

function isSearchEngineUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase();
    const href = url.href;
    return /\/search/i.test(url.pathname) && /(^|\.)(google|bing|brave|yahoo|yandex|baidu|ecosia|startpage)\./.test(host)
      || /(^|\.)duckduckgo\.com$/i.test(host)
      || /google\.[^/]+\/search/i.test(href)
      || /bing\.com\/search/i.test(href);
  } catch {
    return false;
  }
}

function queryFromSearchUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.searchParams.get('q') || url.searchParams.get('query') || url.searchParams.get('p') || '';
  } catch {
    return '';
  }
}

function samePageUrl(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (value) => value.replace(/\/$/, '');
    return left.origin === right.origin && path(left.pathname) === path(right.pathname);
  } catch {
    return String(a || '') === String(b || '');
  }
}

function stayOnPageAction(query) {
  const pattern = String(query || '').trim();
  return pattern
    ? { name: 'grep', params: { pattern, limit: 20 } }
    : { name: 'page_content', params: { format: 'markdown' } };
}

function rewriteOffTabTool(toolName, args, pin, input) {
  if (!pin.attached) return null;
  const n = canonicalToolName(toolName);
  if (n === 'web_search' || n === 'web_extract') {
    if (userAskedToLeaveAttachedTab(input)) return null;
    return stayOnPageAction(args.query || args.q || args.url || args.text || args.pattern);
  }
  if (n === 'browser_exec' || n === 'browser_run') {
    const coerced = coerceRunOrExec(args || {});
    if (!coerced) return stayOnPageAction(args.query || args.q || args.pattern || '');
    if (coerced.name === 'evaluate' || coerced.name === 'run') return coerced;
    if (coerced.name === 'snapshot') return coerced;
    return stayOnAttachedTab(coerced, pin, input);
  }
  return null;
}

function stayOnAttachedTab(action, pin, input) {
  if (!pin.attached || !action) return action;
  if (userAllowsChromeNavigation(input)) {
    if (action.name === 'tabs' && /^(create|new|open|new_page)$/i.test(String(action.params?.action || ''))) {
      return {
        name: 'tabs',
        params: {
          ...action.params,
          action: 'create',
          openerTabId: action.params?.openerTabId ?? pin.tabId
        }
      };
    }
    return action;
  }
  if (action.name === 'navigate') {
    const url = String(action.params?.url || '');
    if (isSearchEngineUrl(url)) return stayOnPageAction(queryFromSearchUrl(url));
    if (pin.url && samePageUrl(url, pin.url)) return { name: 'snapshot', params: {} };
    if (pin.url) {
      try {
        if (new URL(url, pin.url).origin !== new URL(pin.url).origin) {
          return { name: 'snapshot', params: {} };
        }
      } catch {}
    }
  }
  if (action.name === 'tabs') {
    const verb = String(action.params?.action || 'list').toLowerCase();
    if (/^(create|new|open|new_page)$/.test(verb)) return { name: 'snapshot', params: {} };
    if (/^(close|switch)$/.test(verb) && pin.tabId != null) {
      const target = action.params?.tabId ?? action.params?.id;
      if (target != null && Number(target) !== Number(pin.tabId)) return { name: 'snapshot', params: {} };
    }
  }
  if (action.name === 'windows') {
    const verb = String(action.params?.action || 'list').toLowerCase();
    if (/^(create|new)$/.test(verb)) return { name: 'snapshot', params: {} };
  }
  return action;
}

function mirrorBrowserAction(threadId, toolCallId, tool, res, mirroredTools, input = {}) {
  if (mirroredTools.has(toolCallId)) return;
  let args;
  try { args = typeof tool.args === 'string' ? JSON.parse(tool.args || '{}') : (tool.args || {}); }
  catch { return; } // streamed JSON is not complete yet
  const pin = attachPin(input, threadId);
  const rewritten = rewriteOffTabTool(tool.name, args, pin, input);
  let action = rewritten;
  if (!action) {
    if (!isBrowserCompanionTool(tool.name)) return;
    action = stayOnAttachedTab(normalizeBrowserTool(tool.name, args), pin, input);
  }
  if (!action || !actionReadyToMirror(action)) return;
  mirroredTools.add(toolCallId);
  const requestId = uid('browser_');
  const payload = { kind: 'browser-action', requestId, toolCallId, action };
  if (pin.tabId != null) payload.tabId = pin.tabId;
  const sent = wsSend(payload);
  if (sent) {
    mirrorStreams.set(requestId, { res, threadId, toolCallId, toolName: tool.name });
    setTimeout(() => mirrorStreams.delete(requestId), 120_000);
  }
  const stayed = Boolean(rewritten) || (action && isBrowserCompanionTool(tool.name) && action.name !== normalizeBrowserTool(tool.name, args)?.name);
  res.write(sse(custom('agent-status', {
    phase: sent ? 'browser' : 'browser-unavailable',
    label: sent
      ? (stayed ? `Staying on attached tab instead of ${tool.name}…` : `Mirroring ${tool.name} in attached tab…`)
      : 'Browser companion is not connected',
    requestId, toolCallId, toolName: tool.name, tabId: pin.tabId, rewritten: stayed
  })));
}

// ---------------------------------------------------------------------------
// AG-UI event helpers
// ---------------------------------------------------------------------------
function sse(frame) { return `data: ${JSON.stringify(frame)}\n\n`; }
function runStarted(threadId, runId) { return { type: 'RUN_STARTED', threadId, runId, timestamp: Date.now() }; }
function runFinished(threadId, runId) { return { type: 'RUN_FINISHED', threadId, runId, timestamp: Date.now() }; }
function runError(threadId, runId, message, code) { return { type: 'RUN_ERROR', threadId, runId, message, code, timestamp: Date.now() }; }
function textStart(messageId) { return { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant', timestamp: Date.now() }; }
function textDelta(messageId, delta) { return { type: 'TEXT_MESSAGE_CONTENT', messageId, delta, timestamp: Date.now() }; }
function textEnd(messageId) { return { type: 'TEXT_MESSAGE_END', messageId, timestamp: Date.now() }; }
function toolStart(toolCallId, name) { return { type: 'TOOL_CALL_START', toolCallId, name, timestamp: Date.now() }; }
function toolDelta(toolCallId, args) { return { type: 'TOOL_CALL_ARGS', toolCallId, delta: typeof args === 'string' ? args : JSON.stringify(args), timestamp: Date.now() }; }
function toolEnd(toolCallId) { return { type: 'TOOL_CALL_END', toolCallId, timestamp: Date.now() }; }
function messagesSnapshot(messages) { return { type: 'MESSAGES_SNAPSHOT', messages, timestamp: Date.now() }; }
function stateSnapshot(state) { return { type: 'STATE_SNAPSHOT', state, timestamp: Date.now() }; }
function custom(kind, data = {}) { return { type: 'CUSTOM', kind, ...data, timestamp: Date.now() }; }
function uid(prefix) { return prefix + Math.random().toString(36).slice(2); }

// ---------------------------------------------------------------------------
// Hermes browser-tool bridge
// ---------------------------------------------------------------------------
const MIRRORABLE_BROWSER_TOOLS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_back',
  'browser_press',
  'browser_get_images',
  'browser_check',
  'browser_uncheck',
  'browser_clear',
  'browser_hover',
  'browser_focus',
  'browser_select',
  'browser_wait',
  'browser_read',
  'browser_grep',
  'browser_diff',
  'browser_evaluate',
  'browser_click_at',
  'browser_type_at',
  'browser_hover_at',
  'browser_drag',
  'browser_fill',
  'browser_forward',
  'browser_reload',
  'browser_tabs',
  'browser_windows',
  'browser_tab_groups',
  'browser_history',
  'browser_downloads',
  'browser_screenshot',
  'browser_pdf',
  'browser_upload',
  'browser_run',
  'browser_bookmarks',
  'browser_cookies',
  'browser_console',
  'browser_dialog',
  'browser_page_content',
  'browser_links',
  'browser_dom',
  'browser_search_dom',
  'browser_zoom',
  'browser_new_page',
  'browser_close_page',
  'browser_switch_tab',
  'browser_active_tab',
  'browser_move_page',
  'browser_exec',
  'browser_cdp',
  'browser_hold_click',
  'browser_network',
  'browser_clipboard',
  'browser_viewport',
  'browser_find',
  'browser_dblclick',
  'browser_right_click',
  'browser_forms',
  'browser_tables',
  'browser_meta',
  'browser_selection',
  'browser_highlight',
  'browser_frames',
  'browser_storage',
  'browser_attrs',
  'browser_count',
  'browser_scroll_into_view',
  'browser_visible',
  'browser_sessions',
  'browser_top_sites',
  'browser_vision',
  'browser_discard'
]);

// Public BrowserOS MCP catalog names → companion actions. Ideas only, no source.
const TOOL_ALIASES = {
  navigate_page: 'browser_navigate',
  new_page: 'browser_new_page',
  close_page: 'browser_close_page',
  list_pages: 'browser_tabs',
  show_page: 'browser_switch_tab',
  get_active_page: 'browser_active_tab',
  move_page: 'browser_move_page',
  take_snapshot: 'browser_snapshot',
  take_enhanced_snapshot: 'browser_snapshot',
  get_page_content: 'browser_page_content',
  get_page_links: 'browser_links',
  get_dom: 'browser_dom',
  search_dom: 'browser_search_dom',
  take_screenshot: 'browser_screenshot',
  evaluate_script: 'browser_evaluate',
  press_key: 'browser_press',
  upload_file: 'browser_upload',
  handle_dialog: 'browser_dialog',
  save_pdf: 'browser_pdf',
  save_screenshot: 'browser_screenshot',
  download_file: 'browser_downloads',
  list_windows: 'browser_windows',
  create_window: 'browser_windows',
  close_window: 'browser_windows',
  activate_window: 'browser_windows',
  list_tab_groups: 'browser_tab_groups',
  group_tabs: 'browser_tab_groups',
  update_tab_group: 'browser_tab_groups',
  ungroup_tabs: 'browser_tab_groups',
  close_tab_group: 'browser_tab_groups',
  get_bookmarks: 'browser_bookmarks',
  create_bookmark: 'browser_bookmarks',
  remove_bookmark: 'browser_bookmarks',
  update_bookmark: 'browser_bookmarks',
  search_bookmarks: 'browser_bookmarks',
  search_history: 'browser_history',
  get_recent_history: 'browser_history',
  delete_history_url: 'browser_history',
  delete_history_range: 'browser_history',
  act: 'browser_act',
  browser_exec: 'browser_exec',
  hold_click: 'browser_hold_click',
  long_click: 'browser_hold_click',
  list_network_requests: 'browser_network',
  get_network_request: 'browser_network',
  resize_page: 'browser_viewport',
  dblclick: 'browser_dblclick',
  double_click: 'browser_dblclick',
  right_click: 'browser_right_click',
  context_click: 'browser_right_click',
  get_forms: 'browser_forms',
  get_tables: 'browser_tables',
  page_meta: 'browser_meta',
  get_selection: 'browser_selection',
  list_iframes: 'browser_frames',
  local_storage: 'browser_storage',
  recently_closed: 'browser_sessions',
  top_sites: 'browser_top_sites'
};

function canonicalToolName(name = '') {
  const raw = String(name || '').trim().toLowerCase();
  return TOOL_ALIASES[raw] || raw;
}

function isBrowserCompanionTool(name = '') {
  const n = canonicalToolName(name);
  return n === 'browser_act' || MIRRORABLE_BROWSER_TOOLS.has(n);
}

function companionToolNames() {
  return [...MIRRORABLE_BROWSER_TOOLS].sort();
}

function normalizeToolName(entry) {
  if (typeof entry === 'string') return entry;
  return String(entry?.name || entry?.id || entry?.tool || '').trim();
}

/** Merge the active-tab companion catalog into Hermes runtime metadata. */
function withCompanionCatalog(runtime = {}) {
  const companion = companionToolNames();
  const toolsets = Array.isArray(runtime.toolsets)
    ? runtime.toolsets.map((row) => ({
      ...row,
      tools: Array.isArray(row.tools) ? row.tools.map(normalizeToolName).filter(Boolean) : []
    }))
    : [];
  const browserIdx = toolsets.findIndex((row) => /browser/i.test(String(row.name || row.label || '')) && row.name !== 'companion');
  if (browserIdx >= 0) {
    const have = new Set(toolsets[browserIdx].tools.map((name) => String(name).toLowerCase()));
    for (const name of companion) {
      if (!have.has(name)) toolsets[browserIdx].tools.push(name);
    }
    toolsets[browserIdx].tools.sort((a, b) => String(a).localeCompare(String(b)));
  }
  if (!toolsets.some((row) => row.name === 'companion')) {
    toolsets.push({
      name: 'companion',
      label: 'Browser companion',
      description: 'Active-tab actions this extension can mirror when Hermes calls them.',
      enabled: true,
      configured: true,
      source: 'hermes-browser-companion',
      companion: true,
      tools: companion
    });
  }

  const enabled = toolsets.filter((row) => row?.enabled !== false);
  const unique = new Set();
  for (const row of enabled) {
    for (const name of row.tools || []) unique.add(String(name).toLowerCase());
  }
  const skills = Array.isArray(runtime.skills) ? runtime.skills : [];
  const enabledSkills = skills.filter((row) => row?.enabled !== false);
  return {
    ...runtime,
    toolsets,
    summary: {
      ...(runtime.summary || {}),
      toolsets: toolsets.length,
      enabledToolsets: enabled.length,
      tools: unique.size,
      skills: skills.length,
      enabledSkills: enabledSkills.length,
      companionTools: companion.length
    }
  };
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || !(text.startsWith('[') || text.startsWith('{'))) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function looksLikeJsExpression(code) {
  const src = String(code || '').trim();
  if (!src) return false;
  if (/\b(def |import |from |print\(|new_tab\(|page_info\(|start_remote_daemon)\b/.test(src)) return false;
  return /\b(document|window|location|querySelector|innerText|textContent)\b/.test(src)
    || /^(document|window|location)\b/.test(src);
}

function extractActionList(args = {}) {
  for (const key of ['actions', 'steps', 'commands', 'ops', 'batch', 'tasks', 'sequence']) {
    const parsed = parseMaybeJson(args[key]);
    if (Array.isArray(parsed) && parsed.length) return parsed;
    if (parsed && typeof parsed === 'object' && (parsed.name || parsed.action)) return [parsed];
  }
  return [];
}

function isRunWrapperName(name = '') {
  return /^(browser[_-]?)?(run|exec)$/i.test(String(name || '').trim());
}

function normalizeCompanionAction(name, args) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  return normalizeBrowserTool(raw, args)
    || (!/^browser[_-]/i.test(raw) ? normalizeBrowserTool(`browser_${raw}`, args) : null);
}

/** Hermes browser_exec takes Python {code}; models also send a single action or empty args. */
function coerceRunOrExec(args = {}) {
  const list = extractActionList(args);
  if (list.length === 1) {
    const only = list[0] && typeof list[0] === 'object' ? list[0] : { name: list[0] };
    const name = only.name || only.action || only.tool;
    if (name && !isRunWrapperName(name)) {
      return normalizeCompanionAction(name, only.params || only.payload || only.args || only)
        || { name: String(name).replace(/^browser[_-]?/i, ''), params: only.params || only };
    }
  }
  if (list.length > 1) return { name: 'run', params: { actions: list } };

  const expr = args.expression || args.js;
  const code = args.code || args.script || args.python;
  if (expr && looksLikeJsExpression(expr)) return { name: 'evaluate', params: { expression: expr } };
  if (code && looksLikeJsExpression(code)) return { name: 'evaluate', params: { expression: code } };
  if (code || expr) return { name: 'snapshot', params: {} };

  const singleName = args.name || args.action || args.tool;
  if (singleName && !isRunWrapperName(singleName)) {
    return normalizeCompanionAction(singleName, args.params || args.payload || args)
      || { name: String(singleName).replace(/^browser[_-]?/i, ''), params: args.params || args };
  }
  return { name: 'snapshot', params: {} };
}

function normalizeBrowserTool(name, args = {}) {
  const raw = String(name || '').trim().toLowerCase();
  const n = canonicalToolName(raw);
  const selector = args.selector || args.element || args.ref || args.target;
  switch (n) {
    case 'browser_navigate':
      return { name: 'navigate', params: { url: args.url || args.href } };
    case 'browser_snapshot':
      return { name: 'snapshot', params: {} };
    case 'browser_click':
      return { name: 'click', params: { selector } };
    case 'browser_type':
      return { name: 'type_into', params: { selector, text: args.text ?? args.value ?? '', clear: args.clear !== false } };
    case 'browser_scroll':
      return { name: 'scroll', params: { direction: args.direction, amount: args.amount, selector, y: args.y } };
    case 'browser_back':
      return { name: 'back', params: {} };
    case 'browser_press':
      return { name: 'key', params: { keys: args.key ?? args.keys ?? args.text } };
    case 'browser_get_images':
      return { name: 'get_images', params: { limit: args.limit } };
    case 'browser_check':
      return { name: 'check', params: { selector } };
    case 'browser_uncheck':
      return { name: 'uncheck', params: { selector } };
    case 'browser_clear':
      return { name: 'clear', params: { selector } };
    case 'browser_hover':
      return { name: 'hover', params: { selector } };
    case 'browser_focus':
      return { name: 'focus', params: { selector } };
    case 'browser_select':
      return { name: 'select_option', params: { selector, value: args.value ?? args.option ?? args.text } };
    case 'browser_wait':
      return { name: 'wait', params: args };
    case 'browser_read':
      return { name: 'read', params: { selector, prop: args.prop } };
    case 'browser_grep':
      return { name: 'grep', params: { pattern: args.pattern || args.query, over: args.over, limit: args.limit } };
    case 'browser_diff':
      return { name: 'diff', params: { baseline: args.baseline || args.key } };
    case 'browser_evaluate':
      return { name: 'evaluate', params: { expression: args.expression || args.script || args.js } };
    case 'browser_click_at':
      return { name: 'click_at', params: { x: args.x, y: args.y, button: args.button, clickCount: args.clickCount } };
    case 'browser_type_at':
      return { name: 'type_into', params: { selector, text: args.text ?? args.value, clear: args.clear } };
    case 'browser_hover_at':
      return { name: 'hover_at', params: { selector, x: args.x, y: args.y } };
    case 'browser_drag':
      return { name: 'drag', params: { ref: args.ref || args.from, targetRef: args.targetRef || args.to } };
    case 'browser_fill':
      return { name: 'fill_many', params: { fields: args.fields || [] } };
    case 'browser_forward':
      return { name: 'forward', params: {} };
    case 'browser_reload':
      return { name: 'reload', params: {} };
    case 'browser_tabs':
      return { name: 'tabs', params: args };
    case 'browser_new_page':
      return { name: 'tabs', params: { action: 'create', ...args } };
    case 'browser_close_page':
      return { name: 'tabs', params: { action: 'close', ...args } };
    case 'browser_switch_tab':
      return { name: 'tabs', params: { action: 'switch', ...args } };
    case 'browser_active_tab':
      return { name: 'tabs', params: { action: 'get_active', ...args } };
    case 'browser_move_page':
      return { name: 'tabs', params: { action: 'move', ...args } };
    case 'browser_windows':
      return { name: 'windows', params: args.action ? args : { action: inferWindowAction(raw, args), ...args } };
    case 'browser_tab_groups':
      return { name: 'tab_groups', params: args.action ? args : { action: inferGroupAction(raw, args), ...args } };
    case 'browser_history':
      return { name: 'history', params: args.action ? args : { action: inferHistoryAction(raw, args), ...args } };
    case 'browser_downloads':
      return { name: 'downloads', params: args.action ? args : { action: raw === 'download_file' ? 'start' : 'list', ...args } };
    case 'browser_bookmarks':
      return { name: 'bookmarks', params: args.action ? args : { action: inferBookmarkAction(raw, args), ...args } };
    case 'browser_cookies':
      return { name: 'cookies', params: args };
    case 'browser_console':
      if (args.expression || args.js || args.code) {
        return { name: 'evaluate', params: { expression: args.expression || args.js || args.code } };
      }
      return { name: 'console', params: args };
    case 'browser_dialog':
      return { name: 'dialog', params: args };
    case 'browser_page_content':
      return { name: 'page_content', params: args };
    case 'browser_links':
      return { name: 'page_links', params: args };
    case 'browser_dom':
      return { name: 'page_dom', params: args };
    case 'browser_search_dom':
      return { name: 'search_dom', params: args };
    case 'browser_zoom':
      return { name: 'zoom', params: args };
    case 'browser_screenshot':
    case 'browser_vision':
      return { name: 'screenshot', params: args };
    case 'browser_pdf':
      return { name: 'pdf', params: args };
    case 'browser_upload':
      return { name: 'upload', params: args };
    case 'browser_run':
    case 'browser_exec':
      return coerceRunOrExec(args);
    case 'browser_cdp':
      return { name: 'cdp_info', params: args };
    case 'browser_hold_click':
      return { name: 'hold_click', params: { selector, ms: args.ms ?? args.duration ?? args.timeout } };
    case 'browser_network':
      return { name: 'network', params: args };
    case 'browser_clipboard':
      return { name: 'clipboard', params: args };
    case 'browser_viewport':
      return { name: 'viewport', params: args };
    case 'browser_find':
      return { name: 'find', params: { pattern: args.pattern || args.query || args.text, limit: args.limit } };
    case 'browser_dblclick':
      return { name: 'dblclick', params: { selector } };
    case 'browser_right_click':
      return { name: 'right_click', params: { selector } };
    case 'browser_forms':
      return { name: 'forms', params: args };
    case 'browser_tables':
      return { name: 'tables', params: args };
    case 'browser_meta':
      return { name: 'meta', params: args };
    case 'browser_selection':
      return { name: 'selection', params: args };
    case 'browser_highlight':
      return { name: 'highlight', params: { text: args.text || args.query || args.pattern } };
    case 'browser_frames':
      return { name: 'frames', params: args };
    case 'browser_storage':
      return { name: 'storage', params: args };
    case 'browser_attrs':
      return { name: 'attrs', params: { selector, names: args.names || args.attrs } };
    case 'browser_count':
      return { name: 'count', params: { selector: args.selector || args.css || selector } };
    case 'browser_scroll_into_view':
      return { name: 'scroll_into_view', params: { selector } };
    case 'browser_visible':
      return { name: 'visible', params: { selector } };
    case 'browser_sessions':
      return { name: 'sessions', params: args };
    case 'browser_top_sites':
      return { name: 'top_sites', params: args };
    case 'browser_discard':
      return { name: 'discard', params: args };
    case 'browser_act': {
      const actName = args.name || args.action || args.tool;
      if (!actName || !isBrowserCompanionTool(actName) || canonicalToolName(actName) === 'browser_act') return null;
      return normalizeBrowserTool(actName, args.params || args.payload || args);
    }
    default:
      return null;
  }
}

function inferWindowAction(name, args) {
  const raw = String(name || '').toLowerCase();
  if (raw === 'create_window') return 'create';
  if (raw === 'close_window') return 'close';
  if (raw === 'activate_window') return 'focus';
  return 'list';
}

function inferGroupAction(name, args) {
  const raw = String(name || '').toLowerCase();
  if (raw === 'group_tabs' || args.tabIds) return 'create';
  if (raw === 'update_tab_group') return 'update';
  if (raw === 'ungroup_tabs') return 'ungroup';
  if (raw === 'close_tab_group') return 'close';
  return 'list';
}

function inferHistoryAction(name, args) {
  const raw = String(name || '').toLowerCase();
  if (raw === 'get_recent_history') return 'recent';
  if (raw === 'delete_history_url') return 'delete_url';
  if (raw === 'delete_history_range') return 'delete_range';
  return 'search';
}

function inferBookmarkAction(name, args) {
  const raw = String(name || '').toLowerCase();
  if (raw === 'create_bookmark' || (args.title && args.url && !args.id)) return 'create';
  if (raw === 'remove_bookmark') return 'remove';
  if (raw === 'update_bookmark') return 'update';
  if (raw === 'search_bookmarks' || args.query) return 'search';
  return 'list';
}

async function runAgent(threadId, runId, input, res) {
  const origin = String(res.req?.headers?.origin || '');
  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  };
  if (origin && isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(200, headers);

  res.write(sse(runStarted(threadId, runId)));
  res.write(sse(custom('agent-status', { phase: 'thinking', label: 'Thinking…' })));

  const roleMessages = (input.messages || []).map((m) => ({
    id: m.id || uid('msg_'),
    role: m.role || 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  }));
  res.write(sse(messagesSnapshot(roleMessages)));
  if (input.state) res.write(sse(stateSnapshot(input.state)));

  const userText = buildHermesPrompt(input, threadId);
  const messageId = uid('asst_');
  let cancelIfClientGone = null;

  try {
    const { stream, sessionId, stream_id: streamId } = await hermes.chatStream(userText, {
      model: input.model,
      modelProvider: input.modelProvider,
      workspace: input.workspace,
      attached: attachPin(input, threadId).attached,
      sessionId: sessionIdForThread(threadId, input.model, input.modelProvider)
    });
    if (threadId && sessionId) {
      rememberThread(hermesSessions, threadId, {
        sessionId,
        model: input.model || '',
        provider: input.modelProvider || ''
      });
    }
    const req = res.req;
    cancelIfClientGone = () => {
      if (!res.writableEnded) hermes.cancelStream(streamId).catch(() => {});
    };
    req?.once?.('close', cancelIfClientGone);

    res.write(sse(textStart(messageId)));
    const toolAccum = new Map();
    const announcedTools = new Set();
    const mirroredTools = new Set();
    let sawVisibleText = false;

    const takeText = (payload) => {
      if (payload == null) return '';
      if (typeof payload === 'string') return payload;
      return String(payload.text || payload.delta || payload.content || payload.output || payload.message || '');
    };

    for await (const { event, data, final } of readSSE(stream)) {
      if (final) break;
      const eventName = String(event || data?.type || '').toLowerCase();
      // Only the Hermes run terminal events end the turn. tool_complete and
      // step "complete" payloads often set done:true and must not stop tokens.
      if (eventName === 'done' || eventName === 'stream_end') break;
      if (!data) continue;
      if ((eventName === 'token' || eventName === 'interim_assistant' || eventName === 'assistant' || eventName === 'text' || eventName === 'output') && !data.already_streamed) {
        const chunk = takeText(data);
        if (chunk) {
          sawVisibleText = true;
          res.write(sse(textDelta(messageId, chunk)));
        }
        continue;
      }
      if (eventName === 'reasoning' || eventName === 'thinking') {
        // Never expose raw hidden reasoning; expose lifecycle only.
        res.write(sse(custom('agent-status', { phase: 'reasoning', label: 'Reasoning…' })));
        continue;
      }
      if (eventName === 'metering') {
        res.write(sse(custom('metering', { data })));
        continue;
      }
      if (eventName === 'context_status') {
        res.write(sse(custom('context-status', { data })));
        continue;
      }
      if (eventName === 'apperror' || eventName === 'error' || eventName === 'warning') {
        const detail = takeText(data) || data.error || 'Hermes reported an error';
        res.write(sse(custom('agent-status', { phase: 'error', label: String(detail).slice(0, 180) })));
        if (!sawVisibleText) {
          sawVisibleText = true;
          res.write(sse(textDelta(messageId, `[Hermes] ${detail}`)));
        }
        continue;
      }

      if (eventName === 'tool_complete' || eventName === 'tool_result') {
        continue;
      }
      if (eventName === 'complete') {
        const chunk = takeText(data);
        if (chunk && !data.already_streamed) {
          sawVisibleText = true;
          res.write(sse(textDelta(messageId, chunk)));
        }
        continue;
      }

      if (eventName === 'tool' || eventName === 'tool_call' || data.type === 'tool_call' || (data.name && data.args !== undefined)) {
        const tcid = data.tool_call_id || data.id || uid('tool_');
        const name = data.name || data.tool_name || toolAccum.get(tcid)?.name || '';
        const args = data.args ?? data.arguments ?? {};
        const existing = toolAccum.get(tcid) || { name, args: '' };
        if (name) existing.name = name;
        if (typeof args === 'string') existing.args += args;
        else existing.args = args;
        toolAccum.set(tcid, existing);
        mirrorBrowserAction(threadId, tcid, existing, res, mirroredTools, input);

        if (!announcedTools.has(tcid)) {
          announcedTools.add(tcid);
          res.write(sse(toolStart(tcid, existing.name)));
          res.write(sse(custom('agent-status', {
            phase: 'tool',
            label: existing.name ? `Using ${existing.name}…` : 'Using a tool…',
            toolCallId: tcid,
            toolName: existing.name
          })));
        }
        continue;
      }

    }

    if (!sawVisibleText) {
      res.write(sse(textDelta(messageId, 'The selected model returned no visible text. Try another model, or press Stop and send again.')));
    }
    res.write(sse(textEnd(messageId)));

    for (const [tcid, tool] of toolAccum) {
      if (!announcedTools.has(tcid)) res.write(sse(toolStart(tcid, tool.name)));
      res.write(sse(toolDelta(tcid, tool.args)));
      res.write(sse(toolEnd(tcid)));
    }

    // Give fast active-tab actions a short bounded window to arrive on the
    // same AG-UI stream. This is deliberately finite and cannot deadlock on
    // Hermes tool execution.
    if ([...mirrorStreams.values()].some((entry) => entry.res === res)) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    res.write(sse(custom('agent-status', { phase: 'done', label: 'Done' })));
    res.write(sse(runFinished(threadId, runId)));
  } catch (e) {
    res.write(sse(runError(threadId, runId, e.message, 'bridge_error')));
  } finally {
    if (cancelIfClientGone) try { res.req?.off?.('close', cancelIfClientGone); } catch {}
    res.end();
  }
}

/** Build the Hermes turn with page context + role-preserving conversation. */
function buildHermesPrompt(input, threadId = input.threadId) {
  const parts = [];
  const pageContext = (input.context || []).find((ctx) => ctx.type === 'page_context' || ctx.document);
  const pin = attachPin(input, threadId);
  const attached = pin.attached;

  for (const ctx of input.context || []) {
    if (ctx.type === 'page_context' || ctx.document) {
      parts.push(
        `[PAGE CONTEXT]\nURL: ${ctx.url || input.attachedTab?.url || ''}\nTITLE: ${ctx.title || input.attachedTab?.title || ''}\nTAB: ${ctx.tabId || input.attachedTab?.id || 'active'}\n\n${ctx.document || ''}` +
        (ctx.accessibility ? `\n\n[ACCESSIBILITY SNAPSHOT]\n${ctx.accessibility}` : '') +
        (ctx.signals?.length
          ? `\n\n[PAGE STATUS SIGNALS]\n${ctx.signals.map((s) => `- ${s.hidden ? '[hidden] ' : ''}${s.role || 'signal'}: ${s.text || ''}`).join('\n')}`
          : '') +
        (ctx.interactive?.length
          ? `\n\n[INTERACTIVE ELEMENTS]\n${ctx.interactive.map((i) => `- ${i.ref || ''} ${i.selector || ''} (${i.tag || ''}) ${i.text || i.value || i.placeholder || ''}`).join('\n')}`
          : '')
      );
    } else {
      parts.push(`[CONTEXT ${ctx.type || 'context'}]\n${JSON.stringify(ctx)}`);
    }
  }

  if (attached) {
    const url = pin.url || pageContext?.url || input.attachedTab?.url || '';
    const tabId = pin.tabId ?? pageContext?.tabId ?? input.attachedTab?.id;
    parts.push(
      `[ATTACHED LIVE TAB]\n` +
      `The user attached their real Chrome tab${tabId != null ? ` #${tabId}` : ''}${url ? ` (${url})` : ''}. This Chrome window is your workspace, not a Hermes-internal or headless browser.\n` +
      `Sandbox: never open Hermes' internal browser, Playwright, Browserbase, or another product. Only act in this Chrome.\n` +
      `Answer from [PAGE CONTEXT] first. Click and read on this tab by default.\n` +
      `If the user asks to open a tab, article, or URL, use browser_tabs(action=create, url=https://...) or browser_navigate in THIS Chrome. That is allowed.\n` +
      `Do not call web_search or web_extract to re-fetch this page.\n` +
      `Do not browser_navigate to this same URL or to a search engine unless the user asks.\n` +
      `If you need more of the page, call browser_snapshot, browser_page_content, browser_read, browser_scroll, or browser_grep.`
    );
  }

  for (const message of input.messages || []) {
    const role = String(message.role || 'user').toLowerCase();
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    if (role === 'tool') parts.push(`[TOOL RESULT]\n${content}`);
    else if (role === 'assistant') parts.push(`[ASSISTANT]\n${content}`);
    else if (role === 'system') parts.push(`[SYSTEM]\n${content}`);
    else if (role === 'user') parts.push(`[USER REQUEST]\n${content}`);
  }

  const mirrorResults = threadMirrorResults.get(threadId) || [];
  if (mirrorResults.length) {
    parts.push(`[VERIFIED ACTIVE TAB RESULTS]\n${mirrorResults.map((item) => `- ${item.toolName || 'browser tool'}: ${JSON.stringify(item.result)}`).join('\n')}`);
  }

  // Keep this list aligned with Hermes' current core browser tool reference.
  // These are Hermes-native capabilities, not invented extension-only tools.
  const tools = [
    'browser_navigate(url)',
    'browser_snapshot(full?)',
    'browser_click(@eN)',
    'browser_click_at(x, y)',
    'browser_type(@eN, text)',
    'browser_type_at(@eN, text, clear?)',
    'browser_fill(fields[])',
    'browser_scroll(direction, amount?, @eN?)',
    'browser_back()',
    'browser_forward()',
    'browser_reload()',
    'browser_press(key)',
    'browser_focus(@eN)',
    'browser_hover(@eN)',
    'browser_hover_at(x, y)',
    'browser_check(@eN)',
    'browser_uncheck(@eN)',
    'browser_select(@eN, value)',
    'browser_clear(@eN)',
    'browser_drag(@eN, @eN)',
    'browser_read(@eN)',
    'browser_grep(pattern, over?, limit?)',
    'browser_diff(baseline?)',
    'browser_wait(selector?, text?, timeout?)',
    'browser_get_images(limit?)',
    'browser_evaluate(expression)',
    'browser_console(level?, limit?)',
    'browser_dialog(action=accept|dismiss|observe, text?)',
    'browser_cdp()',
    'browser_run(actions:[{name, params}])',
    'browser_hold_click(@eN, ms?)',
    'browser_network(limit?)',
    'browser_clipboard(action=read|write, text?)',
    'browser_viewport(action=get|set, width?, height?)',
    'browser_find(text)',
    'browser_dblclick(@eN)',
    'browser_right_click(@eN)',
    'browser_forms()',
    'browser_tables(limit?)',
    'browser_meta()',
    'browser_selection()',
    'browser_highlight(text)',
    'browser_frames()',
    'browser_storage(action=list|get|set|remove, key?)',
    'browser_attrs(@eN)',
    'browser_count(selector)',
    'browser_scroll_into_view(@eN)',
    'browser_visible(@eN)',
    'browser_sessions()',
    'browser_top_sites()',
    'browser_discard(tabId?)',
    'browser_vision()',
    'browser_tabs(action=list|create|close|switch|duplicate|pin|mute|move, tabId?, url?)',
    'browser_windows(action=list|create|close|focus|update, windowId?, url?)',
    'browser_tab_groups(action=list|create|update|ungroup|close, tabIds?, title?)',
    'browser_history(action=search|recent|delete_url|delete_range, query?, url?)',
    'browser_downloads(action=list|start|cancel|show, url?, id?)',
    'browser_bookmarks(action=list|search|create|update|remove, query?, title?, url?)',
    'browser_cookies(action=list|get|set|remove, url?, name?)',
    'browser_page_content(format=markdown|text|html|links)',
    'browser_links(limit?)',
    'browser_dom()',
    'browser_search_dom(selector?, text?)',
    'browser_zoom(action=get|set|reset, factor?)',
    'browser_screenshot(format?)',
    'browser_pdf()',
    'browser_upload(@eN, file)'
  ];
  parts.push(
    `[HERMES BROWSER TOOLSET]\n${tools.join('\n')}\n\n` +
    (attached
      ? 'You are already in the user\'s real Chrome. Default to the attached tab and @e1 refs. If they ask to open a tab or URL, do it in this Chrome. Do not open another browser product. Unprompted search/navigate-away calls stay on this tab. '
      : 'When no page is attached, prefer web_search/web_extract for simple information retrieval and browser tools for interaction. ') +
    'Answer the user in plain language first. Do not print fake JSON tool calls as prose. The browser companion mirrors compatible browser actions into the user\'s attached tab.'
  );

  if (attached) parts.unshift(workingBrowserBlock(pin));
  return parts.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// Hermes model/runtime proxy helpers
// ---------------------------------------------------------------------------
function pushInventoryModel(out, seen, item, provider, providerLabel, extra = {}) {
  const rawId = typeof item === 'string' ? item : (item?.id || item?.model || item?.name);
  if (!rawId) return;
  const providerId = String(provider || '').trim();
  const qualified = providerId && providerId !== 'moa' && !String(rawId).startsWith('@')
    ? `@${providerId}:${rawId}`
    : String(rawId);
  if (seen.has(qualified)) return;
  seen.add(qualified);
  out.push({
    ...(typeof item === 'object' && item ? item : {}),
    id: qualified,
    label: typeof item === 'string' ? item : (item.label || item.display_name || rawId),
    provider: providerId,
    providerLabel: providerLabel || providerId,
    configured: extra.configured,
    source: extra.source || 'catalog'
  });
}

function groupModelBuckets(group = {}) {
  return [
    ...(Array.isArray(group.models) ? group.models : []),
    ...(Array.isArray(group.extra_models) ? group.extra_models : []),
    ...(Array.isArray(group.available_models) ? group.available_models : []),
    ...(Array.isArray(group.model_list) ? group.model_list : [])
  ];
}

async function modelInventory() {
  let providerData = null;
  try { providerData = await hermes.requestJson('/api/providers'); } catch {}
  let catalogData = {};
  try { catalogData = await hermes.requestJson('/api/models'); } catch {}
  if (!providerData) providerData = catalogData;

  const out = [];
  const seen = new Set();
  const providerMeta = new Map();

  if (Array.isArray(providerData?.providers)) {
    for (const group of providerData.providers) {
      const configured = group.has_key === true && !group.auth_error;
      providerMeta.set(String(group.id || ''), {
        label: group.display_name || group.id,
        configured
      });
      const blocked = Boolean(group.auth_error) && group.has_key !== true;
      const items = groupModelBuckets(group);
      if (blocked && !items.length) continue;
      for (const item of items) {
        pushInventoryModel(out, seen, item, group.id, group.display_name || group.id, {
          configured,
          source: 'provider'
        });
      }
    }
  }

  for (const group of catalogData?.groups || providerData?.groups || []) {
    const provider = group.provider_id || group.id || '';
    const meta = providerMeta.get(String(provider));
    for (const item of groupModelBuckets(group)) {
      pushInventoryModel(out, seen, item, provider, group.provider || group.display_name || meta?.label || provider, {
        configured: meta?.configured,
        source: 'catalog'
      });
    }
  }

  if (Array.isArray(catalogData?.models)) {
    for (const item of catalogData.models) {
      pushInventoryModel(out, seen, item, catalogData.active_provider || cfg.modelProvider, catalogData.active_provider, {
        source: 'catalog'
      });
    }
  }

  const fallbackModel = catalogData?.default_model || cfg.model;
  const fallbackProvider = catalogData?.active_provider || providerData?.active_provider || cfg.modelProvider;
  if (fallbackModel) {
    pushInventoryModel(out, seen, fallbackModel, fallbackProvider, providerMeta.get(String(fallbackProvider))?.label || fallbackProvider, {
      configured: true,
      source: 'default'
    });
  }

  out.sort((a, b) => {
    const configuredDelta = Number(Boolean(b.configured)) - Number(Boolean(a.configured));
    if (configuredDelta) return configuredDelta;
    return String(a.providerLabel).localeCompare(String(b.providerLabel)) || String(a.label).localeCompare(String(b.label));
  });

  return {
    object: 'list',
    active_provider: catalogData?.active_provider || providerData?.active_provider,
    default_model: catalogData?.default_model || providerData?.default_model,
    data: out
  };
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || '');
  if (!isAllowedOrigin(origin)) {
    json(res, 403, { error: 'origin_not_allowed' });
    return;
  }
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  const route = (req.url || '').split('?')[0];

  if (req.method === 'GET' && route === '/v1/models') {
    try {
      json(res, 200, await modelInventory());
    } catch (e) {
      json(res, 200, { object: 'list', error: e.message, data: [] });
    }
    return;
  }

  if (req.method === 'GET' && route === '/v1/runtime') {
    try {
      const runtime = withCompanionCatalog(await hermes.runtimeOverview());
      json(res, 200, {
        object: 'hermes.runtime',
        hermes: cfg.hermesUrl,
        ...runtime
      });
    } catch (e) {
      json(res, 502, { object: 'hermes.runtime', error: e.message, toolsets: [], skills: [] });
    }
    return;
  }

  if (req.method === 'GET' && route === '/healthz') {
    let hermesOk = false;
    let hermesInfo = '';
    try {
      await hermes.requestJson('/api/models');
      hermesOk = true;
      hermesInfo = 'authenticated';
    } catch (e) {
      hermesInfo = e.message;
    }
    json(res, 200, {
      ok: true,
      hermes: cfg.hermesUrl,
      hermesOk,
      hermesInfo,
      wsClients: wsClients.size,
      pendingBrowserActions: pendingToolResults.size,
      authRequired: Boolean(cfg.authToken),
      version: '0.3.2'
    });
    return;
  }

  if (req.method === 'POST' && route === '/tool-result') {
    let body;
    try { body = await readRequestBody(req); }
    catch (e) {
      json(res, e.code === 'request_too_large' ? 413 : 400, { error: e.message });
      return;
    }
    let payload;
    try { payload = JSON.parse(body); } catch { payload = {}; }
    const matched = resolveToolResult({ kind: 'browser-result', ...payload });
    json(res, matched ? 200 : 404, { ok: matched });
    return;
  }

  if (req.method === 'POST' && route === '/agent') {
    let body;
    try { body = await readRequestBody(req); }
    catch (e) {
      json(res, e.code === 'request_too_large' ? 413 : 400, { error: e.message });
      return;
    }
    let input;
    try {
      input = JSON.parse(body);
    } catch (e) {
      json(res, 400, { error: { message: 'Invalid JSON: ' + e.message } });
      return;
    }
    const threadId = input.threadId || uid('thread_');
    const runId = input.runId || uid('run_');
    await runAgent(threadId, runId, input, res);
    return;
  }

  json(res, 404, { error: 'not_found' });
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ req, origin }) => isAllowedOrigin(origin || req.headers.origin || '') && isAuthorized(req)
});

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', message: `Connected to Hermes bridge on :${PORT}` }));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.kind === 'browser-result') resolveToolResult(msg);
  });
  ws.on('close', () => wsClients.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[hermes-bridge] listening on http://127.0.0.1:${PORT}`);
  console.log(`[hermes-bridge] AG-UI endpoint : POST /agent`);
  console.log(`[hermes-bridge] runtime         : GET /v1/runtime`);
  console.log(`[hermes-bridge] WS              : ws://127.0.0.1:${PORT}/ws`);
  console.log(`[hermes-bridge] hermes          : ${cfg.hermesUrl}`);
  console.log(`[hermes-bridge] model           : ${cfg.model} (${cfg.modelProvider})`);
  console.log(`[hermes-bridge] auth            : ${cfg.authToken ? 'token required' : 'local-only / no bridge token'}`);
  if (!cfg.password) console.warn('[hermes-bridge] WARNING: HERMES_PASSWORD not set — Hermes login will fail.');
});