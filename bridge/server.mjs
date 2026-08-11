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
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingToolResults.delete(requestId);
  pending.resolve(payload.result || payload);
  return true;
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
  'browser_get_images'
]);

function isBrowserCompanionTool(name = '') {
  return MIRRORABLE_BROWSER_TOOLS.has(String(name || '').trim().toLowerCase());
}

function normalizeBrowserTool(name, args = {}) {
  const n = String(name || '').toLowerCase();
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
    default:
      return null;
  }
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

  const userText = buildHermesPrompt(input);
  const messageId = uid('asst_');

  try {
    const { stream, sessionId } = await hermes.chatStream(userText, {
      model: input.model,
      modelProvider: input.modelProvider,
      workspace: input.workspace,
      sessionId: hermesSessions.get(threadId) || undefined
    });
    if (threadId && sessionId) hermesSessions.set(threadId, sessionId);

    res.write(sse(textStart(messageId)));
    const toolAccum = new Map();
    const announcedTools = new Set();

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

        if (!announcedTools.has(tcid)) {
          announcedTools.add(tcid);
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
      res.write(sse(toolStart(tcid, tool.name)));
      res.write(sse(toolDelta(tcid, tool.args)));
      res.write(sse(toolEnd(tcid)));
    }

    // Mirror only the Hermes core tools that map faithfully onto the active tab.
    // browser_console/browser_vision remain Hermes-native and are still shown in
    // the tool timeline; we do not fake an extension implementation for them.
    const browserTools = [...toolAccum.entries()].filter(([, tool]) => isBrowserCompanionTool(tool.name));
    for (const [tcid, tool] of browserTools) {
      let action;
      try {
        const args = typeof tool.args === 'string' ? JSON.parse(tool.args || '{}') : tool.args;
        action = normalizeBrowserTool(tool.name, args || {});
      } catch (e) {
        res.write(sse(custom('tool-result', {
          toolCallId: tcid,
          ok: false,
          error: `Could not parse browser tool arguments: ${e.message}`
        })));
        continue;
      }
      if (!action) continue;

      const requestId = uid('browser_');
      const sent = wsSend({ kind: 'browser-action', requestId, toolCallId: tcid, action });
      if (!sent) {
        res.write(sse(custom('tool-result', {
          requestId,
          toolCallId: tcid,
          ok: false,
          error: 'No Hermes Browser companion is connected'
        })));
        continue;
      }

      res.write(sse(custom('agent-status', {
        phase: 'browser',
        label: `Mirroring ${tool.name} in active tab…`,
        requestId,
        toolCallId: tcid,
        toolName: tool.name
      })));
      const reply = await waitToolResult(requestId);
      res.write(sse(custom('tool-result', {
        requestId,
        toolCallId: tcid,
        ok: reply.ok !== false,
        ...(reply.ok === false ? { error: reply.error || 'browser action failed' } : reply)
      })));
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
function buildHermesPrompt(input) {
  const parts = [];

  for (const ctx of input.context || []) {
    if (ctx.type === 'page_context' || ctx.document) {
      parts.push(
        `[PAGE CONTEXT]\nURL: ${ctx.url || ''}\nTITLE: ${ctx.title || ''}\n\n${ctx.document || ''}` +
        (ctx.accessibility ? `\n\n[ACCESSIBILITY SNAPSHOT]\n${ctx.accessibility}` : '') +
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

  // Keep this list aligned with Hermes' current core browser tool reference.
  // These are Hermes-native capabilities, not invented extension-only tools.
  const tools = [
    'browser_navigate(url)',
    'browser_snapshot(full?)',
    'browser_click(@eN)',
    'browser_type(@eN, text)',
    'browser_scroll(direction, amount?)',
    'browser_back()',
    'browser_press(key)',
    'browser_get_images()',
    'browser_console()',
    'browser_vision()'
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
      const active = group.id === cfg.modelProvider || group.id === providerData.active_provider;
      if (!configured && !active) continue;
      for (const item of group.models || []) {
        const id = typeof item === 'string' ? item : item.id;
        if (!id) continue;
        out.push({
          id: group.id === 'moa' ? id : `@${group.id}:${id}`,
          label: typeof item === 'string' ? item : (item.label || id),
          provider: group.id,
          providerLabel: group.display_name || group.id,
          ...(typeof item === 'object' && item ? item : {})
        });
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
      version: '0.3.0'
    });
    return;
  }

  if (req.method === 'POST' && route === '/tool-result') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { payload = {}; }
    const matched = resolveToolResult({ kind: 'browser-result', ...payload });
    json(res, matched ? 200 : 404, { ok: matched });
    return;
  }

  if (req.method === 'POST' && route === '/agent') {
    let body = '';
    for await (const chunk of req) body += chunk;
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