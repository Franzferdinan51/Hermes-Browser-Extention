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
