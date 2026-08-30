import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THINKING_STATUSES,
  thinkingIndicatorMarkup,
} from '../extension/lib/web-thinking-indicator.mjs';

test('Web thinking indicator uses the same Hermes Browser status sequence and accessible glyph markup', () => {
  assert.deepEqual(THINKING_STATUSES, [
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

  const markup = thinkingIndicatorMarkup();
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /\(o_o\)/);
  assert.equal((markup.match(/class="thinking-line"/g) || []).length, THINKING_STATUSES.length);
  assert.equal((markup.match(/class="thinking-dots"/g) || []).length, THINKING_STATUSES.length);
});
