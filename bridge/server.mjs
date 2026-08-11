/**
 * server.mjs — Hermes ⇄ AG-UI bridge.
 *
 * Exposes Hermes Agent as an AG-UI-compatible agent endpoint so a browser
 * extension (or any AG-UI client) can talk to it over the protocol.
 *
 * Endpoints:
 *   POST /agent                 AG-UI HTTP agent endpoint (Accept: text/event-stream)
 *   GET  /healthz               liveness + hermes reachability
 *   WS   /ws                    WebSocket control+event channel (extension subscribes,
 *                               and posts browser tool results back)
 *   POST /tool-result           alternative JSON channel for tool results
 *
 * Browser tool-call handoff:
 *   - When Hermes emits a tool call named browser_* (or tool name contains
 *     "browser" / "web"), the bridge pushes {kind:'browser-action', action} to
 *     connected WebSocket clients, waits for a {kind:'browser-result'} reply,
 *     and resumes Hermes by starting a new turn passing the tool result text.
 *
 * Usage:  node server.mjs
 * Env:    PORT, HERMES_URL, HERMES_PASSWORD, MODEL, MODEL_PROVIDER, WORKSPACE
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { HermesClient, readSSE } from './hermes.mjs';

// ---- Env bootstrap: auto-load ~/.hermes/.hermes-webui.env so the bridge can
// reach Hermes without the user copying secrets. The password is read but never
// echoed to the console. ---- 
function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { console.warn('[hermes-bridge] could not load ' + file + ': ' + e.message); }
}
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
loadEnvFile(path.join(HERMES_HOME, '.hermes-webui.env'));

const PORT = Number(process.env.PORT || 8965);
const cfg = {
  hermesUrl: process.env.HERMES_URL || `http://127.0.0.1:${process.env.HERMES_WEBUI_PORT || 8787}`,
  password: process.env.HERMES_PASSWORD || process.env.HERMES_WEBUI_PASSWORD || '',
  model: process.env.MODEL || 'qwen3.5-9b',
  modelProvider: process.env.MODEL_PROVIDER || 'lmstudio',
  workspace: process.env.WORKSPACE || ''
};

const hermes = new HermesClient({
  baseUrl: cfg.hermesUrl,
  password: cfg.password,
  model: cfg.model,
  modelProvider: cfg.modelProvider,
  workspace: cfg.workspace
});

// ----------------------------------------------------------------------
// WebSocket channel to the extension (browser tool-call handoff)
// ----------------------------------------------------------------------
const wsClients = new Set();
let lastWsReply = null;

function wsSend(obj) {
  for (const c of wsClients) { try { if (c.readyState === 1) c.send(JSON.stringify(obj)); } catch {} }
}

function waitToolResult(timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'timed out waiting for browser action result' }), timeoutMs);
    const onMsg = (payload) => {
      if (payload && payload.kind === 'browser-result') {
        clearTimeout(timer);
        wsClients.delete(lastWsReply);
        resolve(payload.result || { ok: false });
      }
    };
    // A single pending listener receives results via a module-level hook.
    lastOnWsMessage = onMsg;
  });
}
let lastOnWsMessage = null;

// ----------------------------------------------------------------------
// AG-UI event helpers
// ----------------------------------------------------------------------
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

function uid(p) { return p + Math.random().toString(36).slice(2); }

// ----------------------------------------------------------------------
// Browser tool detection + extraction of resolved args
// ----------------------------------------------------------------------
const BROWSER_TOOL_RE = /browser|web|page|dom|navigate|click|scroll|fill|read/i;

async function runAgent(threadId, runId, input, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });

  res.write(sse(runStarted(threadId, runId)));

  // Emit a messages snapshot of what we sent.
  const roleMessages = (input.messages || []).map((m) => ({
    id: m.id || uid('msg_'), role: m.role || 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  }));
  res.write(sse(messagesSnapshot(roleMessages)));
  if (input.state) res.write(sse(stateSnapshot(input.state)));

  // Build a single user message for Hermes from the RunAgentInput.
  const userText = buildHermesPrompt(input);
  const messageId = uid('asst_');

  try {
    const { stream } = await hermes.chatStream(userText, {
      model: input.model, modelProvider: input.modelProvider, workspace: input.workspace,
      sessionId: threadId || undefined
    });

    res.write(sse(textStart(messageId)));

    // Tool-call accumulation (sparse; Hermes sends reasoning/tool frames we surface).
    const toolAccum = new Map(); // toolCallId -> {name, args}
    let sawTool = null;

    for await (const { event, data, final } of readSSE(stream)) {
      if (final) break;

      if (!data) continue;

      // ---- token / reasoning: stream as text content ----
      if ((event === 'token') && typeof data.text === 'string') {
        res.write(sse(textDelta(messageId, data.text)));
        continue;
      }
      if (event === 'reasoning') {
        // Surface reasoning as compact tool-call-ish note (protocol: skip or expose).
        // We skip raw reasoning to keep UI clean; optionally emit CUSTOM.
        continue;
      }
      if (event === 'metering' || event === 'context_status') continue;

      // ---- tool call detection ----
      if (event === 'tool_call' || (data.type === 'tool_call') || (data.name && data.args !== undefined)) {
        const tcid = data.tool_call_id || data.id || uid('tool_');
        const name = data.name || data.tool_name || '';
        const args = data.args ?? data.arguments ?? {};
        const existing = toolAccum.get(tcid) || { name, args: '' };
        // If args are streamed as string chunks, accumulate; else final.
        if (typeof args === 'string') { existing.args += args; }
        else existing.args = args;
        toolAccum.set(tcid, existing);
        if (!sawTool) { sawTool = tcid; }
        continue;
      }

      // ---- done / complete ----
      if (event === 'done' || event === 'complete' || data.done) break;
    }

    res.write(sse(textEnd(messageId)));

    // Emit finalized tool calls if any accumulated.
    for (const [tcid, t] of toolAccum) {
      res.write(sse(toolStart(tcid, t.name)));
      res.write(sse(toolDelta(tcid, t.args)));
      res.write(sse(toolEnd(tcid)));
    }

    // If Hermes made browser tool calls, hand them to the extension.
    const browserTools = [...toolAccum.values()].filter((t) => BROWSER_TOOL_RE.test(t.name));
    if (browserTools.length > 0) {
      for (const t of browserTools) {
        let action = null;
        try {
          const args = typeof t.args === 'string' ? JSON.parse(t.args || '{}') : t.args;
          action = normalizeBrowserTool(t.name, args);
        } catch { action = null; }
        if (action) {
          wsSend({ kind: 'browser-action', action });
          const reply = await waitToolResult();
          if (reply.ok) res.write(sse({ type: 'CUSTOM', kind: 'tool-result', ...reply }));
          else res.write(sse({ type: 'CUSTOM', kind: 'tool-result', ok: false, error: reply.error }));
        }
      }
    }

    res.write(sse(runFinished(threadId, runId)));
  } catch (e) {
    res.write(sse(runError(threadId, runId, e.message, 'bridge_error')));
  }
  finally {
    res.end();
  }
}

/** Convert a Hermes tool name + args into a page-actor action for the extension. */
function normalizeBrowserTool(name, args = {}) {
  const n = name.toLowerCase();
  if (/read|snapshot|extract|page/.test(n)) {
    return { name: 'read', params: { selector: args.selector, prop: args.prop } };
  }
  if (/click/.test(n)) return { name: 'click', params: { selector: args.selector || args.element } };
  if (/fill|input|type|set/.test(n)) return { name: 'set_value', params: { selector: args.selector || args.element, value: args.value ?? args.text ?? args.type } };
  if (/scroll/.test(n)) return { name: 'scroll', params: { direction: args.direction, amount: args.amount, selector: args.selector, y: args.y } };
  if (/navigate|goto/.test(n)) return { name: 'navigate', params: { url: args.url } };
  return { name: 'custom', params: { name, ...args } };
}

/** Build a single prompt for Hermes from an AG-UI RunAgentInput. */
function buildHermesPrompt(input) {
  const parts = [];

  // Enumerate context forks (page snapshots etc.)
  if (input.context && input.context.length) {
    for (const ctx of input.context) {
      if (ctx.type === 'page_context' || ctx.document) {
        parts.push(
          `[PAGE CONTEXT]\nURL: ${ctx.url || ''}\nTITLE: ${ctx.title || ''}\n\n${ctx.document}\n` +
          (ctx.interactive ? `\n[INTERACTIVE ELEMENTS]\n${ctx.interactive.map((i) => `- ${i.selector} (${i.tag}) ${i.text || i.value || i.placeholder || ''}`).join('\n')}\n` : '')
        );
      } else {
        parts.push(`[CONTEXT ${ctx.type || 'context'}]\n${JSON.stringify(ctx)}`);
      }
    }
  }

  // Messages: include any tool results in prior turns + the user text.
  const msgs = input.messages || [];
  for (const m of msgs) {
    const role = m.role || 'user';
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (role === 'tool') parts.push(`[TOOL RESULT]\n${content}`);
    else if (role === 'assistant') parts.push(`[ASSISTANT]\n${content}`);
  }

  // The tools Hermes can use — always include browser tools.
  const tools = [
    'browser_read_page', 'browser_click(selector)', 'browser_fill(selector,value)',
    'browser_type(selector,text)', 'browser_scroll(direction,amount)', 'browser_extract(selector,prop)',
    'browser_navigate(url)'
  ];
  parts.push(`[AVAILABLE BROWSER TOOLS]\n${tools.join('\n')}\n\nUse these tools to read and control the page the user is viewing. Prefer them over guessing. When a tool call is needed, emit it in the stream with name + JSON args.`);

  return parts.join('\n\n').trim();
}

// ----------------------------------------------------------------------
// WebSocket server
// ----------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const route = (req.url || '').split('?')[0];

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && route === '/healthz') {
    let hermesOk = false; let hermesInfo = '';
    try {
      const r = await fetch(`${cfg.hermesUrl}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: cfg.password })
      });
      hermesOk = r.ok; hermesInfo = `HTTP ${r.status}`;
    } catch (e) { hermesInfo = e.message; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hermes: cfg.hermesUrl, hermesOk, hermesInfo, wsClients: wsClients.size, version: '0.1.0' }));
    return;
  }

  if (req.method === 'POST' && route === '/tool-result') {
    let body = '';
    for await (const c of req) body += c;
    let payload; try { payload = JSON.parse(body); } catch { payload = {}; }
    if (lastOnWsMessage) { lastOnWsMessage(payload); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && route === '/agent') {
    let body = '';
    for await (const c of req) body += c;
    let input;
    try { input = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON: ' + e.message } }));
      return;
    }
    const threadId = input.threadId || uid('thread_');
    const runId = input.runId || uid('run_');
    await runAgent(threadId, runId, input, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// WS upgrade
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', message: `Connected to Hermes bridge on :${PORT}` }));
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.kind === 'browser-result' && lastOnWsMessage) {
      const hooked = lastOnWsMessage;
      lastOnWsMessage = null;
      hooked(msg);
    }
  });
  ws.on('close', () => wsClients.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[hermes-bridge] listening on http://127.0.0.1:${PORT}`);
  console.log(`[hermes-bridge] AG-UI endpoint : POST /agent (Accept: text/event-stream)`);
  console.log(`[hermes-bridge] WS              : ws://127.0.0.1:${PORT}/ws`);
  console.log(`[hermes-bridge] hermes          : ${cfg.hermesUrl}`);
  console.log(`[hermes-bridge] model           : ${cfg.model} (${cfg.modelProvider})`);
  if (!cfg.password) console.warn('[hermes-bridge] WARNING: HERMES_PASSWORD not set — set it or Hermes login will fail.');
});