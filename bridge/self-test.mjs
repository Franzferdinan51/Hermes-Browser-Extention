/**
 * self-test.mjs — verifies the bridge's Hermes -> AG-UI translation pipeline
 * without a live Hermes runtime. A fake Hermes WebUI serves login/session/chat
 * routes and records the prompt the bridge actually sent.
 *
 * Run: node self-test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_PORT = 9997;
const BRIDGE_PORT = 9988;

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

// ---- Fake Hermes ----
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
    emit('tool_call', { tool_call_id: 't1', name: 'browser_read_page', args: { selector: 'body' } });
    emit('token', { text: 'Hermes!' });
    emit('done', {});
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url.includes('/api/providers')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ providers: [{ id: 'lmstudio', display_name: 'LM Studio', has_key: true, models: ['fake-model'] }], active_provider: 'lmstudio' }));
    return;
  }
  if (req.method === 'GET' && req.url.includes('/api/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ active_provider: 'lmstudio', default_model: 'fake-model', groups: [] }));
    return;
  }
  res.writeHead(404);
  res.end('{}');
});
fake.listen(FAKE_PORT, '127.0.0.1');

// ---- Spawn bridge pointed at fake ----
const bridgeEnv = {
  ...process.env,
  PORT: String(BRIDGE_PORT),
  HERMES_URL: `http://127.0.0.1:${FAKE_PORT}`,
  HERMES_PASSWORD: 'secret',
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

async function main() {
  await wait(700);

  // 1. healthz
  let hz;
  try { hz = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`)).json(); }
  catch (e) { hz = { error: e.message }; }
  ok(hz.ok === true && hz.hermesOk === true, 'healthz reports Hermes reachable');
  ok(hz.version === '0.2.0', 'healthz exposes bridge version');

  // 2. model discovery
  let models = {};
  try { models = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/models`)).json(); } catch {}
  ok(models.data?.some((m) => m.id === '@lmstudio:fake-model'), 'model endpoint flattens configured Hermes provider');

  // 3. POST /agent -> AG-UI SSE
  let body = '';
  try {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
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
  ok(body.includes('"TOOL_CALL_START"') && body.includes('browser_read_page'), 'translates Hermes tool_call into TOOL_CALL events');
  ok(body.includes('"kind":"context-status"'), 'surfaces context status as CUSTOM metadata');
  ok(body.includes('"kind":"metering"'), 'surfaces metering as CUSTOM metadata');
  ok(body.includes('"phase":"reasoning"'), 'surfaces reasoning lifecycle without raw reasoning');
  ok(!body.includes('private reasoning should not be surfaced'), 'does not leak raw Hermes reasoning text');
  ok(body.includes('No Hermes Browser companion is connected'), 'browser tool fails fast when no companion is connected');
  ok(body.includes('"RUN_FINISHED"'), 'emits RUN_FINISHED without orphan stream');

  // 4. Critical prompt contract: the actual user request must reach Hermes.
  const sentMessage = String(lastChatStartPayload?.message || '');
  ok(sentMessage.includes('[USER]\nsummarize this page'), 'Hermes prompt includes current user message');
  ok(sentMessage.includes('[PAGE CONTEXT]') && sentMessage.includes('https://example.com'), 'Hermes prompt includes page context');
  ok(sentMessage.includes('browser_click') && sentMessage.includes('@e1'), 'Hermes prompt advertises browser tools and accessibility refs');

  console.log(`\n[${passed} passed, ${failed} failed]`);
  child.kill();
  fake.close();
  if (failed) {
    console.log('\n--- bridge log ---\n' + bridgeLog.slice(-2500));
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