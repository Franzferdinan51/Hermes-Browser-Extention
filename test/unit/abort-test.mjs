/**
 * abort-test.mjs — drives the shipped AGUIClient.abortRun() against a hanging
 * SSE server. Fails if abort is a no-op (the run would hang until timeout).
 */
import http from 'node:http';
import { AGUIClient, abortSucceeded } from '../../extension/lib/agui-client.js';

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'thread_stop', runId: 'run_stop' })}\n\n`);
  // Intentionally never ends — abort must cancel this fetch.
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const client = new AGUIClient({ url: `http://127.0.0.1:${port}/agent` });

ok(abortSucceeded({ ok: true, aborted: false }) === false, 'ok:true without aborted is not a successful stop');
ok(abortSucceeded({ ok: true, aborted: true }) === true, 'aborted:true is a successful stop');
ok(client.abortRun() === true, 'abortRun records a cancel even before prepareRun');
ok(client.wasCanceled() === true, 'wasCanceled is true after abortRun');

const preflight = new AGUIClient({ url: 'http://127.0.0.1:9/agent' });
preflight.prepareRun();
ok(preflight.abortRun() === true, 'abortRun succeeds during preflight before fetch');
let preflightAborted = false;
try {
  await preflight.runAgent({ messages: [{ role: 'user', content: 'should not fetch' }] });
} catch (error) {
  preflightAborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message || error));
}
ok(preflightAborted, 'runAgent honors cancel requested before fetch and does not start /agent');

const idle = new AGUIClient({ url: `http://127.0.0.1:1/unused` });
ok(idle.wasCanceled() === false, 'fresh client is not canceled');

const live = new AGUIClient({ url: `http://127.0.0.1:${port}/agent` });
live.prepareRun();
const run = live.runAgent({ messages: [{ role: 'user', content: 'hang' }] });
await new Promise((resolve) => setTimeout(resolve, 80));
ok(live.busy === true, 'runAgent marks the client busy');
const aborted = live.abortRun();
ok(aborted === true, 'abortRun returns true for an in-flight fetch');

let sawAbort = false;
try {
  await Promise.race([
    run,
    new Promise((_, reject) => setTimeout(() => reject(new Error('abort did not cancel the hanging fetch')), 1500))
  ]);
} catch (error) {
  sawAbort = error?.name === 'AbortError' || /abort/i.test(String(error?.message || error));
  if (!sawAbort && String(error?.message || '').includes('did not cancel')) {
    failed++;
    console.log('  ✗ abort cancels the in-flight AG-UI fetch');
  }
}
ok(sawAbort, 'abort cancels the in-flight AG-UI fetch');
ok(live.busy === false, 'client is idle after abort');

server.close();
console.log(`\n[${passed} passed, ${failed} failed]`);
process.exit(failed ? 1 : 0);
