/**
 * content.js — runs in every page (isolated world by default in MV3 with the
 * manifest content_scripts entry; scripting.executeScript uses MAIN world via
 * `world:'MAIN'` when needed). Listens for runtime messages from the service
 * worker and executes page-read / page-action requests.
 *
 * Because content scripts and the page share the same DOM (isolated JS
 * world), we can read and mutate the DOM here directly; executeScript with
 * world:'MAIN' is reserved for pages that hide elements via prototype
 * overrides.
 */
(() => {
  if (globalThis.__HERMES_CONTENT_LOADED__) return;
  globalThis.__HERMES_CONTENT_LOADED__ = true;

  const loadedScripts = [];

  function load(path) {
    // page-reader.js and page-actor.js register globals if not already loaded
    if (loadedScripts.includes(path)) return Promise.resolve();
    loadedScripts.push(path);
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL(path);
      s.onload = () => resolve();
      s.onerror = () => resolve();
      (document.head || document.documentElement).appendChild(s);
    });
  }

  async function ensureLibs() {
    await load('lib/page-reader.js');
    await load('lib/page-actor.js');
  }

  // Message protocol from the SW:
  //   {kind:'read-page'}                     -> snapshot
  //   {kind:'run-action', action}            -> {ok, value|error}
  //   {kind:'run-actions', actions}          -> results[]
  //   {kind:'ping'}                          -> {ok:true}
  //   {kind:'page-state-changed'}            -> push latest snapshot key (SW decides whether to persist)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.kind) return;

    if (msg.kind === 'ping') { sendResponse({ ok: true }); return; }

    if (msg.kind === 'read-page') {
      ensureLibs().then(() => {
        const snap = globalThis.HermesPageReader.readPage();
        sendResponse({ ok: true, snapshot: snap });
      });
      return true; // async
    }

    if (msg.kind === 'run-action') {
      ensureLibs().then(async () => {
        try {
          const r = await globalThis.HermesPageActor.runAction(msg.action);
          sendResponse(r);
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      });
      return true;
    }

    if (msg.kind === 'run-actions') {
      ensureLibs().then(async () => {
        try {
          const results = await globalThis.HermesPageActor.runActions(msg.actions, msg.opts);
          sendResponse({ ok: true, results });
        } catch (e) {
          sendResponse({ ok: false, error: String(e), results: [] });
        }
      });
      return true;
    }
  });

  // Notify the SW when the page heavily changes (SPA navigation detected via a
  // MutationObserver that stays light).
  let lastKey = null;
  const reported = new Set();
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