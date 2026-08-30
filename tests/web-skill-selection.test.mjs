import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelectedWebSkills } from '../extension/lib/web-skill-selection.mjs';

const catalog = [
  { name: 'ai-seo', description: 'Optimize content for AI search.' },
  { name: 'github-workflow-operations', description: 'GitHub operations.' },
];

test('known @ and / Hermes Web skill invocations become canonical selected skills and leave the user request intact', () => {
  assert.deepEqual(
    extractSelectedWebSkills('@ai-seo /github-workflow-operations audit this page', catalog),
    {
      selectedSkills: ['ai-seo', 'github-workflow-operations'],
      message: 'audit this page',
    },
  );
});

test('skill parsing deduplicates known names and preserves unknown slash text for the agent', () => {
  assert.deepEqual(
    extractSelectedWebSkills('/ai-seo @ai-seo /unknown write a brief', catalog),
    {
      selectedSkills: ['ai-seo'],
      message: '/unknown write a brief',
    },
  );
});
