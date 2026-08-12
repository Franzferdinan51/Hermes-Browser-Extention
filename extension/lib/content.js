/**
 * content.js — isolated-world listener for page-read / page-action requests.
 * page-reader.js and page-actor.js are injected as sibling content scripts
 * (manifest or executeScript) and register HermesPageReader / HermesPageActor.
 */
(() => {
  if (globalThis.__HERMES_CONTENT_LOADED__) return;
  globalThis.__HERMES_CONTENT_LOADED__ = true;

  function reader() { return globalThis.HermesPageReader || null; }
  function actor() { return globalThis.HermesPageActor || null; }

  // Message protocol from the SW:
  //   {kind:'read-page'}                     -> snapshot
  //   {kind:'run-action', action}            -> {ok, value|error}
  //   {kind:'run-actions', actions}          -> results[]
  //   {kind:'ping'}                          -> {ok:true}
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.kind) return;

    if (msg.kind === 'ping') { sendResponse({ ok: true }); return; }

    if (msg.kind === 'read-page') {
      const lib = reader();
      if (!lib) {
        sendResponse({ ok: false, error: 'page reader is not loaded' });
        return;
      }
      try { sendResponse({ ok: true, snapshot: lib.readPage() }); }
      catch (e) { sendResponse({ ok: false, error: String(e) }); }
      return;
    }

    if (msg.kind === 'run-action') {
      const lib = actor();
      if (!lib) {
        sendResponse({ ok: false, error: 'page actor is not loaded' });
        return;
      }
      Promise.resolve(lib.runAction(msg.action))
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    if (msg.kind === 'run-actions') {
      const lib = actor();
      if (!lib) {
        sendResponse({ ok: false, error: 'page actor is not loaded', results: [] });
        return;
      }
      Promise.resolve(lib.runActions(msg.actions, msg.opts))
        .then((results) => sendResponse({ ok: true, results }))
        .catch((e) => sendResponse({ ok: false, error: String(e), results: [] }));
      return true;
    }
  });

  // Notify the SW when the page URL/title changes.
  let lastKey = null;
  function report() {
    try {
      const key = (location.href + '|' + document.title);
      if (key !== lastKey) {
        lastKey = key;
        chrome.runtime.sendMessage({ kind: 'tab-changed', url: location.href, title: document.title }).catch(() => {});
      }
    } catch {}
  }
  window.addEventListener('hashchange', report);
  window.addEventListener('popstate', report);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) report(); });

  // Report initial state shortly after load.
  setTimeout(report, 1500);
})();