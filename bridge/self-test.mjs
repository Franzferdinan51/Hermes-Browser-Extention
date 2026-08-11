/**
 * self-test.mjs — verifies Hermes -> AG-UI translation and bridge security
 * without a live Hermes runtime.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
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
    emit('context_status', { used_tokens: 1000, max_tokens: 8000 });
    emit('metering', { input_tokens: 50, output_tokens: 10, total_tokens: 60 });
    emit('token', { text: 'Hello ' });
    emit('reasoning', { text: '(private reasoning should not be surfaced)' });
    emit('token', { text: 'from ' });
    emit('tool_call', { tool_call_id: 't1', name: 'browser_click', args: { element: '@e1' } });
    emit('tool_call', { tool_call_id: 't2', name: 'web_search', args: { query: 'example' } });
    emit('token', { text: 'Hermes!' });
    emit('done', {});
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url.includes('/api/providers')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      providers: [{ id: 'lmstudio', display_name: 'LM Studio', has_key: true, models: ['fake-model'] }],
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
  ok(hz.version === '0.3.0' && hz.authRequired === true, 'healthz exposes secured bridge version');

  // Model discovery.
  let models = {};
  try {
    models = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/models`, { headers: authHeaders })).json();
  } catch {}
  ok(models.data?.some((m) => m.id === '@lmstudio:fake-model'), 'model endpoint flattens configured Hermes provider');

  // Hermes-native toolset + skill metadata.
  let runtime = {};
  try {
    runtime = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/runtime`, { headers: authHeaders })).json();
  } catch {}
  ok(runtime.object === 'hermes.runtime', 'runtime endpoint identifies Hermes runtime payload');
  ok(runtime.summary?.enabledToolsets === 2 && runtime.summary?.tools === 6, 'runtime summarizes enabled toolsets and tools');
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
        context: [{
          type: 'page_context',
          url: 'https://example.com',
          title: 'Example',
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
  ok(body.includes('"phase":"browser-unavailable"'), 'mirrorable browser tool reports missing companion without blocking');
  ok(!body.includes('No Hermes Browser companion is connected","requestId":"web_search'), 'generic web_search is not routed into active-tab DOM execution');
  ok(body.includes('"RUN_FINISHED"'), 'emits RUN_FINISHED without orphan stream');

  // Prompt contract.
  const sentMessage = String(lastChatStartPayload?.message || '');
  ok(sentMessage.includes('[USER REQUEST]\nsummarize this page'), 'Hermes prompt includes current user message');
  ok(sentMessage.includes('[PAGE CONTEXT]') && sentMessage.includes('https://example.com'), 'Hermes prompt includes page context');
  ok(sentMessage.includes('browser_click(@eN)') && sentMessage.includes('browser_console()') && sentMessage.includes('browser_vision()'), 'prompt advertises the Hermes core browser toolset');
  ok(!sentMessage.includes('browser_hover(') && !sentMessage.includes('browser_wait('), 'prompt does not advertise extension-only helpers as Hermes tools');

  console.log(`\n[${passed} passed, ${failed} failed]`);
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