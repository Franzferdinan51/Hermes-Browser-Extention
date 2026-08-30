export const THINKING_STATUSES = Object.freeze([
  'thinking',
  'brainstorming',
  'contemplating',
  'reasoning',
  'processing',
  'analyzing',
  'reflecting',
  'pondering',
  'deliberating',
  'formulating',
]);

export function thinkingIndicatorMarkup() {
  const phrases = THINKING_STATUSES
    .map((word) => `<span class="thinking-line"><span class="thinking-word">${word}</span><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`)
    .join('');
  return `<span class="thinking-indicator" role="status" aria-live="polite" aria-label="Hermes is thinking, brainstorming, contemplating, reasoning, processing, analyzing, reflecting, pondering, deliberating, and formulating"><span class="thinking-glyph" aria-hidden="true">(o_o)</span><span class="thinking-words" aria-hidden="true">${phrases}</span></span>`;
}
