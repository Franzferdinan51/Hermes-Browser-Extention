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

function actionReadyToMirror(action) {
  if (!action?.name) return false;
  const params = action.params || {};
  const needsTarget = new Set([
    'click', 'set_value', 'type_into', 'check', 'uncheck', 'clear', 'hover',
    'focus', 'select_option', 'read', 'fill_many', 'drag'
  ]);
  if (action.name === 'navigate') return Boolean(params.url);
  if (action.name === 'key') return Boolean(params.keys);
  if (action.name === 'grep') return Boolean(params.pattern);
  if (action.name === 'evaluate') return Boolean(params.expression);
  if (action.name === 'fill_many') return Array.isArray(params.fields) && params.fields.length > 0;
  if (action.name === 'drag') return Boolean(params.ref && params.targetRef);
  if (action.name === 'click_at' || action.name === 'hover_at') {
    return Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y));
  }
  if (needsTarget.has(action.name)) return Boolean(params.selector);
  return true;
}

function mirrorBrowserAction(threadId, toolCallId, tool, res, mirroredTools) {
  if (!isBrowserCompanionTool(tool.name) || mirroredTools.has(toolCallId)) return;
  let args;
  try { args = typeof tool.args === 'string' ? JSON.parse(tool.args || '{}') : (tool.args || {}); }
  catch { return; } // streamed JSON is not complete yet
  const action = normalizeBrowserTool(tool.name, args);
  if (!action || !actionReadyToMirror(action)) return;
  mirroredTools.add(toolCallId);
  const requestId = uid('browser_');
  const sent = wsSend({ kind: 'browser-action', requestId, toolCallId, action });
  if (sent) {
    mirrorStreams.set(requestId, { res, threadId, toolCallId, toolName: tool.name });
    setTimeout(() => mirrorStreams.delete(requestId), 120_000);
  }
  res.write(sse(custom('agent-status', {
    phase: sent ? 'browser' : 'browser-unavailable',
    label: sent ? `Mirroring ${tool.name} in active tab…` : 'Browser companion is not connected',
    requestId, toolCallId, toolName: tool.name
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
  'browser_active_tab'
]);

// Public BrowserOS MCP catalog names → companion actions. Ideas only, no source.
const TOOL_ALIASES = {
  navigate_page: 'browser_navigate',
  new_page: 'browser_new_page',
  close_page: 'browser_close_page',
  list_pages: 'browser_tabs',
  show_page: 'browser_switch_tab',
  get_active_page: 'browser_active_tab',
  move_page: 'browser_tabs',
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
  act: 'browser_act'
};

function canonicalToolName(name = '') {
  const raw = String(name || '').trim().toLowerCase();
  return TOOL_ALIASES[raw] || raw;
}

function isBrowserCompanionTool(name = '') {
  const n = canonicalToolName(name);
  return n === 'browser_act' || MIRRORABLE_BROWSER_TOOLS.has(n);
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
      return { name: 'set_value', params: { selector, value: args.text ?? args.value ?? '' } };
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
      return { name: 'screenshot', params: args };
    case 'browser_pdf':
      return { name: 'pdf', params: args };
    case 'browser_upload':
      return { name: 'upload', params: args };
    case 'browser_run':
      return { name: 'run', params: args };
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

  try {
    const { stream, sessionId } = await hermes.chatStream(userText, {
      model: input.model,
      modelProvider: input.modelProvider,
      workspace: input.workspace,
      sessionId: hermesSessions.get(threadId) || undefined
    });
    if (threadId && sessionId) rememberThread(hermesSessions, threadId, sessionId);

    res.write(sse(textStart(messageId)));
    const toolAccum = new Map();
    const announcedTools = new Set();
    const mirroredTools = new Set();

    for await (const { event, data, final } of readSSE(stream)) {
      if (final) break;
      if (!data) continue;

      if (event === 'token' && typeof data.text === 'string') {
        res.write(sse(textDelta(messageId, data.text)));
        continue;
      }
      if (event === 'reasoning') {
        // Never expose raw hidden reasoning; expose lifecycle only.
        res.write(sse(custom('agent-status', { phase: 'reasoning', label: 'Reasoning…' })));
        continue;
      }
      if (event === 'metering') {
        res.write(sse(custom('metering', { data })));
        continue;
      }
      if (event === 'context_status') {
        res.write(sse(custom('context-status', { data })));
        continue;
      }

      if (event === 'tool_call' || data.type === 'tool_call' || (data.name && data.args !== undefined)) {
        const tcid = data.tool_call_id || data.id || uid('tool_');
        const name = data.name || data.tool_name || toolAccum.get(tcid)?.name || '';
        const args = data.args ?? data.arguments ?? {};
        const existing = toolAccum.get(tcid) || { name, args: '' };
        if (name) existing.name = name;
        if (typeof args === 'string') existing.args += args;
        else existing.args = args;
        toolAccum.set(tcid, existing);
        mirrorBrowserAction(threadId, tcid, existing, res, mirroredTools);

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

      if (event === 'done' || event === 'complete' || data.done) break;
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
    res.end();
  }
}

/** Build the Hermes turn with page context + role-preserving conversation. */
function buildHermesPrompt(input, threadId = input.threadId) {
  const parts = [];

  for (const ctx of input.context || []) {
    if (ctx.type === 'page_context' || ctx.document) {
      parts.push(
        `[PAGE CONTEXT]\nURL: ${ctx.url || ''}\nTITLE: ${ctx.title || ''}\n\n${ctx.document || ''}` +
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
    'browser_dialog(action=accept|dismiss|observe, text?)',
    'browser_zoom(action=get|set|reset, factor?)',
    'browser_screenshot(format?)',
    'browser_pdf()',
    'browser_upload(@eN, file)',
    'browser_run(actions[])'
  ];
  parts.push(
    `[HERMES BROWSER TOOLSET]\n${tools.join('\n')}\n\n` +
    'When the browser toolset is available, use Hermes accessibility refs such as @e1 from browser_snapshot. ' +
    'Prefer web_search/web_extract for simple information retrieval and browser tools for interaction. ' +
    'Do not print fake JSON tool calls as prose. The browser companion may mirror compatible browser actions into the user\'s active tab, but Hermes remains the source of truth for tool execution.'
  );

  return parts.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// Hermes model/runtime proxy helpers
// ---------------------------------------------------------------------------
async function modelInventory() {
  let providerData = null;
  try { providerData = await hermes.requestJson('/api/providers'); } catch {}
  let catalogData = {};
  try { catalogData = await hermes.requestJson('/api/models'); } catch {}
  if (!providerData) providerData = catalogData;

  const out = [];
  if (Array.isArray(providerData?.providers)) {
    for (const group of providerData.providers) {
      const configured = group.has_key === true && !group.auth_error;
      const active = group.id === cfg.modelProvider
        || group.id === providerData.active_provider
        || group.id === catalogData.active_provider;
      if (!configured && !active) continue;
      for (const item of group.models || []) {
        const id = typeof item === 'string' ? item : item.id;
        if (!id) continue;
        out.push({
          ...(typeof item === 'object' && item ? item : {}),
          id: group.id === 'moa' ? id : `@${group.id}:${id}`,
          label: typeof item === 'string' ? item : (item.label || id),
          provider: group.id,
          providerLabel: group.display_name || group.id
        });
      }
    }
    if (catalogData.active_provider === 'moa' && !out.some((item) => item.provider === 'moa')) {
      const moaGroup = (catalogData.groups || []).find((group) => group.provider_id === 'moa');
      for (const item of moaGroup?.models || []) {
        if (item?.id) out.push({ id: item.id, label: item.label || item.id, provider: 'moa', providerLabel: moaGroup.provider || 'Mixture of Agents' });
      }
    }
  } else {
    const activeProvider = providerData?.active_provider || cfg.modelProvider;
    for (const group of providerData?.groups || []) {
      const provider = group.provider_id || '';
      if (provider !== activeProvider) continue;
      for (const item of group.models || []) {
        if (!item?.id) continue;
        out.push({
          ...item,
          id: item.id,
          label: item.label || item.id,
          provider,
          providerLabel: group.provider || provider
        });
      }
    }
  }

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
      const runtime = await hermes.runtimeOverview();
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