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

/** Derive the page bar label from get-state, snapshot, or follow events. */
export function pageIdentity(source = {}) {
  const snap = source.snapshot && typeof source.snapshot === 'object' ? source.snapshot : null;
  const nested = snap?.snapshot && typeof snap.snapshot === 'object' ? snap.snapshot : null;
  const page = source.page && typeof source.page === 'object' ? source.page : null;
  const title = String(source.title || page?.title || snap?.title || nested?.title || '').trim();
  const url = String(source.url || page?.url || snap?.url || '').trim();
  const error = String(source.error || '').trim();
  const restricted = source.ok === false && /restrict/i.test(error);
  if (restricted) {
    const where = title || url || 'Restricted page';
    return {
      title: where,
      url,
      label: `${where} — cannot attach. Open a normal http(s) page.`,
      restricted: true,
      empty: false
    };
  }
  if (source.ok === false && error && !title && !url) {
    return { title: '', url: '', label: error, restricted: false, empty: false };
  }
  if (title || url) return { title, url, label: title || url, restricted: false, empty: false };
  return { title: '', url: '', label: '', restricted: false, empty: true };
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
