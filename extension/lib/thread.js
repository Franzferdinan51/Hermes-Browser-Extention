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
