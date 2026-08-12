/**
 * Conversation thread helpers shared by the side panel and service worker.
 * The worker is killed after idle; thread ids must survive that restart.
 */

export function readThreadId(event) {
  if (!event || event.type !== 'RUN_STARTED') return '';
  return String(event.threadId || '').trim();
}

export function buildChatRequest(text, state = {}, extra = {}) {
  const threadId = String(extra.threadId || state.threadId || '').trim();
  return {
    kind: 'chat',
    text: String(text || ''),
    threadId: threadId || undefined,
    attachPage: extra.attachPage,
    model: extra.model,
    modelProvider: extra.modelProvider,
    sendToken: extra.sendToken
  };
}

export function applyStoredThread(stored, fallback = '') {
  const id = String(stored || fallback || '').trim();
  return id || '';
}

export function tabThreadKey(tabId) {
  return tabId == null || tabId === '' ? '' : String(tabId);
}

export function threadForTab(map, tabId) {
  const key = tabThreadKey(tabId);
  return key ? String((map && map[key]) || '') : '';
}

export function bindTabThread(map, tabId, threadId) {
  const next = { ...(map || {}) };
  const key = tabThreadKey(tabId);
  if (!key) return next;
  const id = String(threadId || '').trim();
  if (id) next[key] = id;
  else delete next[key];
  return next;
}

export function appendTranscript(list, role, text, limit = 40) {
  const row = { role: String(role || 'assistant'), text: String(text || '') };
  if (!row.text.trim()) return Array.isArray(list) ? list.slice() : [];
  return [...(Array.isArray(list) ? list : []), row].slice(-Math.max(4, Number(limit) || 40));
}

/** New on one tab: drop that tab's thread binding and its transcript only. */
export function isolateTabConversation(tabThreads, transcripts, tabId) {
  const threads = { ...(tabThreads || {}) };
  const notes = { ...(transcripts || {}) };
  const key = tabThreadKey(tabId);
  const clearedThreadId = key ? String(threads[key] || '') : '';
  if (key) delete threads[key];
  if (clearedThreadId) delete notes[clearedThreadId];
  return { tabThreads: threads, transcripts: notes, clearedThreadId };
}

export function pageIdentityFallback() {
  return 'No page yet — open a normal http(s) tab or press snapshot.';
}

export function isRestrictedUrl(url = '') {
  return /^(chrome|edge|brave|opera|about|devtools|chrome-extension|moz-extension):/i.test(String(url || ''));
}

function pageFailFlag(source = {}, page, url) {
  if (page && Object.prototype.hasOwnProperty.call(page, 'ok')) return page.ok === false;
  if (source.kind === 'page-context-status' || source.following === true) return source.ok === false;
  if (isRestrictedUrl(url)) return true;
  return false;
}

/** Derive the page bar label from get-state, snapshot, or follow events. */
export function pageIdentity(source = {}) {
  const snap = source.snapshot && typeof source.snapshot === 'object' ? source.snapshot : null;
  const nested = snap?.snapshot && typeof snap.snapshot === 'object' ? snap.snapshot : null;
  const page = source.page && typeof source.page === 'object' ? source.page : null;
  const title = String(source.title || page?.title || snap?.title || nested?.title || '').trim();
  const url = String(source.url || page?.url || snap?.url || '').trim();
  const error = String(source.error || page?.error || '').trim();
  const failed = pageFailFlag(source, page, url);
  const restricted = isRestrictedUrl(url);

  if (restricted) {
    const where = title || url || 'Restricted page';
    return {
      title: where,
      url,
      label: `${where} — cannot attach. Open a normal http(s) page.`,
      restricted: true,
      empty: false,
      clobber: true
    };
  }
  if (failed && !title && !url) {
    return { title: '', url: '', label: '', restricted: false, empty: true, clobber: false, error };
  }
  if (title || url) return { title, url, label: title || url, restricted: false, empty: false, clobber: true };
  return { title: '', url: '', label: '', restricted: false, empty: true, clobber: false };
}

/** Skip title-less attach failures so they cannot wipe a known page bar. */
export function shouldApplyPageIdentity(id) {
  return Boolean(id && id.clobber !== false);
}

/** Prefer the followed tab over a snapshot from a different tab. */
export function livePageState({ lastPage, lastSnapshot } = {}) {
  const follow = lastPage && typeof lastPage === 'object' ? lastPage : null;
  const snap = lastSnapshot && typeof lastSnapshot === 'object' ? lastSnapshot : null;
  if (follow && snap && follow.tabId != null && snap.tabId != null && Number(follow.tabId) !== Number(snap.tabId)) {
    return {
      title: follow.title || '',
      url: follow.url || '',
      tabId: follow.tabId,
      ok: follow.ok,
      error: follow.error || ''
    };
  }
  if (follow) {
    return {
      title: follow.title || snap?.title || '',
      url: follow.url || snap?.url || '',
      tabId: follow.tabId ?? snap?.tabId,
      ok: follow.ok,
      error: follow.error || ''
    };
  }
  if (snap) {
    return {
      title: snap.title || '',
      url: snap.url || '',
      tabId: snap.tabId,
      ok: true,
      error: ''
    };
  }
  return null;
}

export function visibleError(error) {
  const raw = String(error?.message || error || '').replace(/^Error:\s*/i, '').trim();
  if (!raw || /^unknown$/i.test(raw)) {
    return 'Could not complete that request. Check the local bridge is running, then Send again.';
  }
  return raw;
}

export function connectionState(source = {}) {
  if (source.clientBusy) return { kind: 'busy', label: 'working' };
  if (source.bridgeConnected) return { kind: 'ok', label: 'connected' };
  return { kind: 'err', label: 'bridge unavailable — start the local bridge or reopen the panel' };
}
