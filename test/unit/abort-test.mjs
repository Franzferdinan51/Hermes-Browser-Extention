/**
 * abort-test.mjs — drives the shipped AGUIClient.abortRun() against a hanging
 * SSE server. Fails if abort is a no-op (the run would hang until timeout).
 */
import http from 'node:http';
import { AGUIClient, abortSucceeded, isLiveGeneration, shouldIdleComposer, abortActiveRun, leftoverAbortedResult } from '../../extension/lib/agui-client.js';

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
ok(isLiveGeneration(1, 2) === false, 'isLiveGeneration is false for stale generation A after B starts');
ok(isLiveGeneration(2, 2) === true, 'isLiveGeneration is true for live generation B');
ok(shouldIdleComposer(1, 2) === false, 'shouldIdleComposer does not idle B for stale send A');
ok(shouldIdleComposer(2, 2) === true, 'shouldIdleComposer idles only the live send');
ok(shouldIdleComposer(undefined, 2) === false, 'token-less run-end does not idle the live send');

const stopped = new AGUIClient({ url: 'http://127.0.0.1:1/unused' });
const genA = stopped.prepareRun();
const abortA = abortActiveRun(stopped);
ok(abortA.aborted === true, 'abortActiveRun aborts the live generation');
ok(abortA.announce === false, 'abort-run does not announce after Stop invalidates A');
ok(leftoverAbortedResult(genA, stopped.activeGeneration).announce === false, 'leftover abortedResult A does not announce after Stop, even before B starts');
const genB = stopped.prepareRun();
ok(genB !== genA && isLiveGeneration(genB, stopped.activeGeneration), 'newer send B is the live generation');
ok(leftoverAbortedResult(genA, stopped.activeGeneration).announce === false, 'leftover abortedResult A does not announce after a newer send');
ok(abortActiveRun(stopped).generation === genB, 'next abort-run targets B, not leftover A');
ok(shouldIdleComposer(genA, genB) === false, 'stale send token A cannot hide live Stop');
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

const race = new AGUIClient({ url: `http://127.0.0.1:${port}/agent` });
const raceA = race.prepareRun();
ok(race.abortRun(raceA) === true, 'abortRun(A) cancels generation A');
const raceB = race.prepareRun();
ok(raceB !== raceA && race.activeGeneration === raceB, 'prepareRun B installs a new generation');
ok(race.abort && race.abort.signal.aborted === false, 'B controller is live after aborting A');
ok(race.abortRun(raceA) === false, 'abortRun(A) is a no-op after B starts');
ok(race.abort && race.abort.signal.aborted === false, 'stale abort A does not kill B');

let staleThrew = false;
try {
  await race.runAgent({ messages: [{ role: 'user', content: 'stale A' }] }, { generation: raceA });
} catch (error) {
  staleThrew = error?.name === 'AbortError' || /abort/i.test(String(error?.message || error));
}
ok(staleThrew, 'leftover run A cannot fetch after B starts');
ok(race.activeGeneration === raceB && race.abort && race.abort.signal.aborted === false, 'stale run A does not clear or abort B');

const runB = race.runAgent({ messages: [{ role: 'user', content: 'B hang' }] }, { generation: raceB });
await new Promise((resolve) => setTimeout(resolve, 80));
ok(race.busy === true, 'run B is in flight');
ok(race.abortRun(raceA) === false, 'aborting A while B is live is a no-op');
ok(race.busy === true && race.abort?.signal?.aborted === false, 'in-flight B survives abort A');
ok(race.abortRun(raceB) === true, 'abortRun(B) cancels the live generation');
let sawBAbort = false;
try {
  await Promise.race([
    runB,
    new Promise((_, reject) => setTimeout(() => reject(new Error('B abort did not cancel')), 1500))
  ]);
} catch (error) {
  sawBAbort = error?.name === 'AbortError' || /abort/i.test(String(error?.message || error));
}
ok(sawBAbort, 'aborting generation B cancels the in-flight fetch');
ok(race.busy === false, 'client is idle after aborting B');

server.close();
console.log(`\n[${passed} passed, ${failed} failed]`);
process.exit(failed ? 1 : 0);
