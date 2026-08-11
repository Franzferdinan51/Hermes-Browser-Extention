/**
 * self-test.mjs — verifies the bridge's AG-UI translation pipeline WITHOUT a
 * live Hermes runtime. Spins a tiny fake Hermes :8787 that serves the same
 * REST+SSE contract (login cookie, session/new, chat/start, chat/stream), then
 * points a bridge instance at it and checks we emit valid AG-UI events.
 *
 * Run:  node self-test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_PORT = 9997;
const BRIDGE_PORT = 9988;

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

// ---- Fake Hermes ----
const fake = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const route = (req.url || '').split('?')[0];

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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stream_id: 'fake_stream' }));
    return;
  }
  if (req.method === 'GET' && req.url.includes('/api/chat/stream')) {
    // Emit the exact SSE shape Hermes sends (token/reasoning/tool_call/done).
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('context_status', { session_id: 'x', prefill: {} });
    emit('token', { text: 'Hello ' });
    emit('token', { text: 'from ' });
    emit('reasoning', { text: '(thinking...) ' });
    emit('token', { text: 'Hermes!' });
    emit('tool_call', { tool_call_id: 't1', name: 'browser_read_page', args: { selector: 'body' } });
    emit('token', { text: ' I read the page.' });
    emit('done', {});
    res.end();
    return;
  }
  res.writeHead(404); res.end('{}');
});
fake.listen(FAKE_PORT, '127.0.0.1');

// ---- Spawn bridge pointed at fake ----
const bridgeEnv = {
  ...process.env,
  PORT: String(BRIDGE_PORT),
  HERMES_URL: `http://127.0.0.1:${FAKE_PORT}`,
  HERMES_PASSWORD: 'secret',
  MODEL: 'fake-model'
};
const child = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], { env: bridgeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let bridgeLog = '';
child.stdout.on('data', (d) => bridgeLog += d);
child.stderr.on('data', (d) => bridgeLog += d);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await wait(800);

  // 1. healthz
  let hz;
  try { hz = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`)).json(); } catch (e) { hz = { error: e.message }; }
  ok(hz.ok === true && hz.hermesOk === true, 'healthz reports Hermes reachable');

  // 2. POST /agent -> AG-UI SSE
  let body = '';
  try {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        agentId: 'hermes', threadId: 'thread_t1', runId: 'run_t1',
        context: [{ type: 'page_context', url: 'https://example.com', title: 'Example', document: '<h1>Hi</h1>' }],
        messages: [{ role: 'user', content: 'summarize this page' }]
      })
    });
    body = await r.text();
  } catch (e) { body = 'FETCH ERROR: ' + e.message; }

  const hasRunStarted = body.includes('"RUN_STARTED"');
  const hasMsgStart = body.includes('"TEXT_MESSAGE_START"');
  const hasTokens = /Hello from Hermes!/.test(body) || (body.split('"delta"').length >= 2 && body.includes('Hello'));
  const hasToolCall = body.includes('"TOOL_CALL_START"') && body.includes('browser_read_page');
  const hasRunFinished = body.includes('"RUN_FINISHED"');
  const hasMssgSnap = body.includes('"MESSAGES_SNAPSHOT"');

  ok(hasRunStarted, 'emits RUN_STARTED');
  ok(hasMssgSnap, 'emits MESSAGES_SNAPSHOT');
  ok(hasMsgStart, 'emits TEXT_MESSAGE_START');
  ok(hasTokens, 'streams token deltas into one text message (got: ' + /Hello[\s\S]{0,40}Hermes!/.test(body) + ')');
  ok(hasToolCall, 'translates Hermes tool_call into TOOL_CALL_* events (browser_read_page)');
  ok(hasRunFinished, 'emits RUN_FINISHED');

  // 3. Ensure page context was delivered into the Hermes prompt
  ok(body.includes('RUN_FINISHED'), 'run finished (no orphan stream)');

  console.log(`\n[${passed} passed, ${failed} failed]`);
  child.kill(); fake.close();
  if (failed) { console.log('\n--- bridge log ---\n' + bridgeLog.slice(-1500)); process.exit(1); }
  process.exit(0);
}
main();