/**
 * self-test.mjs — verifies Hermes -> AG-UI translation and bridge security
 * without a live Hermes runtime.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_PORT = 9997;
const BRIDGE_PORT = 9988;
const BRIDGE_TOKEN = 'bridge-test-token';

let passed = 0;
let failed = 0;
let lastChatStartPayload = null;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

const fake = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'POST' && req.url.includes('/api/auth/login')) {
    res.setHeader('Set-Cookie', 'hermes_session=fakesession; Path=/; HttpOnly; Max-Age=2592000');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && req.url.includes('/api/session/new')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { session_id: 'fake_session_id' } }));
    return;
  }
  if (req.method === 'POST' && req.url.includes('/api/chat/start')) {
    lastChatStartPayload = await readJson(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stream_id: 'fake_stream' }));
    return;
  }
  if (req.method === 'GET' && req.url.includes('/api/chat/stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const prompt = String(lastChatStartPayload?.message || '');
    if (prompt.includes('NAV_SAFETY_PROBE')) {
      emit('tool_call', { tool_call_id: 'tnav', name: 'browser_navigate', args: { url: 'javascript:alert(1)' } });
      emit('done', {});
      res.end();
      return;
    }
    if (prompt.includes('MOVE_PAGE_PROBE')) {
      emit('tool_call', { tool_call_id: 'tmove', name: 'move_page', args: { tabId: 7, index: 2 } });
      emit('done', {});
      res.end();
      return;
    }
    if (prompt.includes('ATTACH_STAY_PROBE')) {
      emit('tool_call', { tool_call_id: 'ts1', name: 'web_search', args: { query: 'example domain' } });
      emit('tool_call', { tool_call_id: 'ts2', name: 'browser_navigate', args: { url: 'https://www.google.com/search?q=example' } });
      emit('tool_call', { tool_call_id: 'ts3', name: 'browser_new_page', args: { url: 'https://www.bing.com/' } });
      emit('done', {});
      res.end();
      return;
    }
    emit('context_status', { used_tokens: 1000, max_tokens: 8000 });
    emit('metering', { input_tokens: 50, output_tokens: 10, total_tokens: 60 });
    emit('token', { text: 'Hello ' });
    emit('reasoning', { text: '(private reasoning should not be surfaced)' });
    emit('token', { text: 'from ' });
    emit('tool_call', { tool_call_id: 't1', name: 'browser_click', args: { element: '@e1' } });
    emit('tool_call', { tool_call_id: 't2', name: 'web_search', args: { query: 'example' } });
    emit('tool_call', { tool_call_id: 't3', name: 'get_page_content', args: { format: 'markdown' } });
    emit('token', { text: 'Hermes!' });
    emit('done', {});
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url.includes('/api/providers')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      providers: [{ id: 'lmstudio', display_name: 'LM Studio', has_key: true, models: ['fake-model', { id: 'object-model', label: 'Object Model' }] }],
      active_provider: 'lmstudio'
    }));
    return;
  }
  if (req.method === 'GET' && req.url.includes('/api/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ active_provider: 'lmstudio', default_model: 'fake-model', groups: [] }));
    return;
  }
  if (req.method === 'GET' && req.url.includes('/api/tools/toolsets')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      {
        name: 'browser',
        label: 'Browser Automation',
        description: 'Browser tools',
        enabled: true,
        configured: true,
        tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type']
      },
      {
        name: 'web',
        label: 'Web Search',
        description: 'Web retrieval',
        enabled: true,
        configured: true,
        tools: ['web_search', 'web_extract']
      },
      {
        name: 'disabled-demo',
        label: 'Disabled Demo',
        enabled: false,
        configured: true,
        tools: ['disabled_tool']
      }
    ]));
    return;
  }
  if (req.method === 'GET' && req.url.includes('/api/skills')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { name: 'browser-research', description: 'Research with browser context', enabled: true, usage: 4, provenance: 'agent' },
      { name: 'disabled-skill', enabled: false, usage: 0, provenance: 'hub' }
    ]));
    return;
  }

  res.writeHead(404);
  res.end('{}');
});
fake.listen(FAKE_PORT, '127.0.0.1');

const bridgeEnv = {
  ...process.env,
  PORT: String(BRIDGE_PORT),
  HERMES_URL: `http://127.0.0.1:${FAKE_PORT}`,
  HERMES_PASSWORD: 'secret',
  BRIDGE_AUTH_TOKEN: BRIDGE_TOKEN,
  MODEL: 'fake-model',
  MODEL_PROVIDER: 'lmstudio'
};
const child = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], {
  env: bridgeEnv,
  stdio: ['ignore', 'pipe', 'pipe']
});
let bridgeLog = '';
child.stdout.on('data', (d) => { bridgeLog += d; });
child.stderr.on('data', (d) => { bridgeLog += d; });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const authHeaders = { Authorization: `Bearer ${BRIDGE_TOKEN}` };

async function main() {
  await wait(700);

  const companionActions = [];
  const companion = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/ws?token=${encodeURIComponent(BRIDGE_TOKEN)}`, {
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  });
  companion.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.kind !== 'browser-action') return;
    companionActions.push(msg);
    companion.send(JSON.stringify({
      kind: 'browser-result',
      requestId: msg.requestId,
      toolCallId: msg.toolCallId,
      result: { ok: true, title: 'Fake active tab' }
    }));
  });
  await new Promise((resolve, reject) => {
    companion.once('open', resolve);
    companion.once('error', reject);
  });

  // Security boundary.
  const noAuth = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`);
  ok(noAuth.status === 401, 'bridge token protects HTTP endpoints');

  const badOrigin = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`, {
    headers: { ...authHeaders, Origin: 'https://evil.example' }
  });
  ok(badOrigin.status === 403, 'rejects non-extension browser origins');

  // Health.
  let hz;
  try {
    hz = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`, { headers: authHeaders })).json();
  } catch (e) {
    hz = { error: e.message };
  }
  ok(hz.ok === true && hz.hermesOk === true, 'healthz reports Hermes reachable');
  ok(hz.version === '0.3.2' && hz.authRequired === true, 'healthz exposes secured bridge version');

  // Model discovery.
  let models = {};
  try {
    models = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/models`, { headers: authHeaders })).json();
  } catch {}
  ok(models.data?.some((m) => m.id === '@lmstudio:fake-model'), 'model endpoint flattens configured Hermes provider');
  ok(models.data?.some((m) => m.id === '@lmstudio:object-model' && m.label === 'Object Model'), 'object-shaped models keep a qualified provider id');

  // Hermes-native toolset + skill metadata.
  let runtime = {};
  try {
    runtime = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/runtime`, { headers: authHeaders })).json();
  } catch {}
  ok(runtime.object === 'hermes.runtime', 'runtime endpoint identifies Hermes runtime payload');
  ok(runtime.summary?.enabledToolsets >= 3, 'runtime includes Hermes toolsets plus the companion catalog');
  ok(runtime.summary?.tools > 20 && runtime.summary?.companionTools > 20, 'runtime tool count includes the companion catalog');
  const browserSet = runtime.toolsets?.find((row) => row.name === 'browser');
  const companionSet = runtime.toolsets?.find((row) => row.name === 'companion');
  ok(browserSet?.tools?.includes('browser_bookmarks') && browserSet?.tools?.includes('browser_tabs') && browserSet?.tools?.includes('browser_page_content'), 'browser toolset is expanded with companion actions');
  ok(companionSet?.tools?.includes('browser_network') && companionSet?.tools?.includes('browser_exec') && companionSet?.tools?.includes('browser_cdp'), 'companion catalog includes Hermes-aligned actions from GitHub');
  ok(companionSet?.tools?.includes('browser_forms') && companionSet?.tools?.includes('browser_tables') && companionSet?.tools?.includes('browser_sessions'), 'companion catalog includes forms, tables, and session tools');
  ok(runtime.summary?.enabledSkills === 1 && runtime.skills?.[0]?.name === 'browser-research', 'runtime exposes Hermes skills and enabled count');

  // AG-UI stream.
  let body = '';
  try {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        agentId: 'hermes',
        threadId: 'thread_t1',
        runId: 'run_t1',
        attachPage: true,
        attachedTab: { id: 99, url: 'https://example.com', title: 'Example' },
        context: [{
          type: 'page_context',
          url: 'https://example.com',
          title: 'Example',
          tabId: 99,
          document: '<h1>Hi</h1>',
          accessibility: '[e1] button "Go"',
          interactive: [{ ref: 'e1', tag: 'button', text: 'Go' }]
        }],
        messages: [{ role: 'user', content: 'summarize this page' }]
      })
    });
    body = await r.text();
  } catch (e) {
    body = 'FETCH ERROR: ' + e.message;
  }

  ok(body.includes('"RUN_STARTED"'), 'emits RUN_STARTED');
  ok(body.includes('"MESSAGES_SNAPSHOT"'), 'emits MESSAGES_SNAPSHOT');
  ok(body.includes('"TEXT_MESSAGE_START"'), 'emits TEXT_MESSAGE_START');
  ok(body.includes('Hello ') && body.includes('Hermes!'), 'streams token deltas');
  ok(body.includes('"TOOL_CALL_START"') && body.includes('browser_click') && body.includes('web_search'), 'renders Hermes browser and non-browser tool calls');
  ok(body.includes('"kind":"context-status"'), 'surfaces context status as CUSTOM metadata');
  ok(body.includes('"kind":"metering"'), 'surfaces metering as CUSTOM metadata');
  ok(body.includes('"phase":"reasoning"'), 'surfaces reasoning lifecycle without raw reasoning');
  ok(!body.includes('private reasoning should not be surfaced'), 'does not leak raw Hermes reasoning text');
  ok(body.includes('"phase":"browser"'), 'mirrorable browser tool is dispatched to companion');
  ok(companionActions.some((msg) => msg.action?.name === 'page_content' && msg.action?.params?.format === 'markdown'), 'BrowserOS catalog alias get_page_content is mirrored independently');
  ok(companionActions.some((msg) => msg.tabId === 99), 'attached tab id is pinned on companion actions');
  ok(companionActions.some((msg) => msg.action?.name === 'grep' && String(msg.action?.params?.pattern || '').includes('example')), 'attached web_search is rewritten onto the live tab');
  ok(body.includes('"kind":"tool-result"') && body.includes('Fake active tab'), 'companion result is returned in AG-UI stream');
  ok(body.indexOf('"TOOL_CALL_START"') >= 0 && body.indexOf('"TOOL_CALL_START"') < body.indexOf('"kind":"tool-result"'), 'tool cards start before companion results arrive');
  ok(!body.includes('No Hermes Browser companion is connected","requestId":"web_search'), 'generic web_search is not routed into active-tab DOM execution');
  ok(body.includes('"RUN_FINISHED"'), 'emits RUN_FINISHED without orphan stream');

  const firstChatPrompt = String(lastChatStartPayload?.message || '');
  const followup = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      agentId: 'hermes', threadId: 'thread_t1', runId: 'run_t2',
      messages: [{ role: 'user', content: 'What happened in the active tab?' }]
    })
  });
  await followup.text();

  // Prompt contract.
  const sentMessage = String(lastChatStartPayload?.message || '');
  ok(firstChatPrompt.includes('[USER REQUEST]\nsummarize this page'), 'Hermes prompt includes current user message');
  ok(firstChatPrompt.includes('[PAGE CONTEXT]') && firstChatPrompt.includes('https://example.com'), 'Hermes prompt includes page context');
  ok(firstChatPrompt.includes('[ATTACHED LIVE TAB]') && firstChatPrompt.includes('Do not call web_search'), 'attached page is bound to the live Chrome tab');
  ok(firstChatPrompt.includes('[WORKING BROWSER]') && firstChatPrompt.includes('already inside the user\'s real Chrome'), 'attached turn tells Hermes to work in this Chrome tab');
  ok(!/prefer web_search\/web_extract for simple information retrieval/i.test(firstChatPrompt), 'attached page does not tell Hermes to search another browser');
  ok(sentMessage.includes('[VERIFIED ACTIVE TAB RESULTS]') && sentMessage.includes('Fake active tab'), 'next turn receives verified active-tab result');
  ok(sentMessage.includes('[WORKING BROWSER]') && sentMessage.includes('https://example.com'), 'follow-up stays bound to the attached Chrome tab');

  const isolated = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      agentId: 'hermes',
      messages: [{ role: 'user', content: 'start a fresh conversation' }]
    })
  });
  await isolated.text();
  const isolatedPrompt = String(lastChatStartPayload?.message || '');
  ok(!isolatedPrompt.includes('[VERIFIED ACTIVE TAB RESULTS]'), 'a new thread does not inherit another conversation\'s tab results');
  ok(!isolatedPrompt.includes('[WORKING BROWSER]') && !isolatedPrompt.includes('[ATTACHED LIVE TAB]'), 'a new thread does not inherit the working-browser pin');
  ok(/When no page is attached, prefer web_search/i.test(isolatedPrompt), 'unattached turns may still use web search');

  ok(firstChatPrompt.includes('browser_click(@eN)') && firstChatPrompt.includes('browser_console(') && firstChatPrompt.includes('browser_vision()'), 'prompt advertises the Hermes core browser toolset');
  ok(firstChatPrompt.includes('browser_check(@eN)') && firstChatPrompt.includes('browser_evaluate(expression)') && firstChatPrompt.includes('browser_tabs(action='), 'prompt advertises expanded BrowserOS-parity tools');
  ok(firstChatPrompt.includes('browser_bookmarks(') && firstChatPrompt.includes('browser_page_content(') && firstChatPrompt.includes('browser_cookies('), 'prompt advertises catalog-inspired chrome tools');

  const beforeSafety = companionActions.length;
  await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ agentId: 'hermes', messages: [{ role: 'user', content: 'NAV_SAFETY_PROBE' }] })
  })).text();
  const navDispatched = companionActions.slice(beforeSafety).some((msg) => String(msg.action?.params?.url || '').startsWith('javascript:'));
  ok(!navDispatched, 'javascript: navigate is not dispatched to the companion');

  const beforeMove = companionActions.length;
  await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ agentId: 'hermes', messages: [{ role: 'user', content: 'MOVE_PAGE_PROBE' }] })
  })).text();
  ok(companionActions.slice(beforeMove).some((msg) => msg.action?.name === 'tabs' && msg.action?.params?.action === 'move' && msg.action?.params?.tabId === 7), 'catalog alias move_page is mirrored as tabs move');

  const beforeStay = companionActions.length;
  await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      agentId: 'hermes',
      attachPage: true,
      attachedTab: { id: 42, url: 'https://example.com/attached', title: 'Attached' },
      context: [{
        type: 'page_context',
        url: 'https://example.com/attached',
        title: 'Attached',
        tabId: 42,
        document: '<h1>Stay here</h1>'
      }],
      messages: [{ role: 'user', content: 'ATTACH_STAY_PROBE summarize this page' }]
    })
  })).text();
  const stayActions = companionActions.slice(beforeStay);
  ok(stayActions.length >= 1 && stayActions.every((msg) => msg.tabId === 42), 'stay-on-tab actions are pinned to the attached tab');
  ok(stayActions.some((msg) => msg.action?.name === 'grep' && String(msg.action?.params?.pattern || '').includes('example')), 'web_search is rewritten to search the attached page');
  ok(!stayActions.some((msg) => msg.action?.name === 'navigate' && /google|bing/i.test(String(msg.action?.params?.url || ''))), 'search-engine navigate is not sent to another browser');
  ok(!stayActions.some((msg) => msg.action?.name === 'tabs' && /^(create|new|open|new_page)$/i.test(String(msg.action?.params?.action || ''))), 'new-page is not opened while a tab is attached');
  ok(stayActions.some((msg) => msg.action?.name === 'snapshot' || msg.action?.name === 'page_content' || msg.action?.name === 'grep'), 'leave-tab tools stay on the attached page');

  console.log(`\n[${passed} passed, ${failed} failed]`);
  companion.close();
  child.kill();
  fake.close();
  if (failed) {
    console.log('\n--- bridge log ---\n' + bridgeLog.slice(-3000));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  child.kill();
  fake.close();
  process.exit(1);
});