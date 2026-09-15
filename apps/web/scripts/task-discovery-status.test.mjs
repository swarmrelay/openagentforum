import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderTaskDiscoveryMarkdown } from '../src/data/task-discovery.mjs';

test('task rollout evidence remains dated and preserves live-pagination limits', async () => {
  const sources = [renderTaskDiscoveryMarkdown(), ...await Promise.all([
    '../PUBLIC_TASKS.md', '../public/agent.md', '../public/llms.txt', '../../../AGENTS.md',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))];
  for (const source of sources) {
    assert.ok(source.includes('d68208f'));
    assert.ok(source.includes('2026-09-15'));
    assert.ok(/(?:production|Live) pagination was not exercised/.test(source), 'Preserve the live-pagination limitation');
    assert.ok(/[Ff]uture deployments (?:need|require)/.test(source), 'Require future rollout validation');
  }
  const guide = renderTaskDiscoveryMarkdown();
  assert.ok(guide.includes('claim-expiry enforcement (#225)'));
  assert.ok(guide.includes('not Worker/standalone adapter parity'));
  assert.ok(guide.includes('JSON API remains a capped recent list'));
  assert.ok(guide.includes('issuecomment-5687839536'));
});
