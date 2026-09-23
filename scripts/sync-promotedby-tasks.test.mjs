import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPromotedByTask, isOpportunityAlreadySynced } from './sync-promotedby-tasks.mjs';
import { generateAgentKeyPair, deriveAgentId, signTaskAction, verifyTaskAction } from '../packages/protocol/dist/index.js';

const mockOpportunity = {
  id: 'cmp_test_123',
  name: 'TestProduct',
  tagline: 'The best developer tool for AI agents',
  description: 'A comprehensive suite for agent coordination and automated tasks.',
  allowed_activities: [
    { key: 'article', label: 'Articles & guest posts' },
    { key: 'listing', label: 'Directories & listings' },
    { key: 'community', label: 'Community & forum answers' },
  ],
  max_per_result_cents: 8000,
  remaining_cents: 50000,
  audience: 'AI agent developers',
  disallowed: 'No fake accounts or spam',
  freedom: 'guided',
  tone: 'technical',
  brief_url: 'https://promotedby.ai/opportunities/test-product',
  submit_url: 'https://promotedby.ai/api/v1/submissions',
};

test('formatPromotedByTask generates bounded, valid task fields', () => {
  const task = formatPromotedByTask(mockOpportunity);

  assert.ok(task.title.startsWith('[promotedby.ai] TestProduct:'));
  assert.ok(task.title.length <= 160);
  assert.ok(task.reward.includes('$80.00 per result'));
  assert.ok(task.reward.includes('$500.00 remaining'));
  assert.ok(task.reward.length <= 512);

  assert.deepEqual(task.requiredCapabilities, ['article', 'listing', 'community']);
  assert.equal(task.timeoutMs, 3600000);

  assert.ok(task.description.includes('Campaign: TestProduct (cmp_test_123)'));
  assert.ok(task.description.includes('https://promotedby.ai/api/v1/submissions'));
  assert.ok(task.description.includes('https://promotedby.ai/agents.md'));
  assert.ok(task.description.length <= 6000);
});

test('formatPromotedByTask sanitizes and bounds capabilities and string fields', () => {
  const malformed = {
    id: 'cmp_overflow',
    name: 'A'.repeat(200),
    tagline: 'B'.repeat(200),
    description: 'C'.repeat(10000),
    allowed_activities: ['article', 'invalid/token!@#', 'x'.repeat(100), 'listing'],
    max_per_result_cents: 12000,
    remaining_cents: 24000,
  };

  const task = formatPromotedByTask(malformed);
  assert.ok(task.title.length <= 160);
  assert.ok(task.reward.length <= 512);
  assert.ok(task.description.length <= 6000);
  assert.deepEqual(task.requiredCapabilities, ['article', 'listing']);
});

test('isOpportunityAlreadySynced detects matching ID or title', () => {
  const existing = [
    { id: 'task_1', title: 'Some normal task', description: 'Just a task' },
    { id: 'task_2', title: '[promotedby.ai] TestProduct: Bounties', description: 'Task details (cmp_test_123)' },
  ];

  assert.equal(isOpportunityAlreadySynced(mockOpportunity, existing), true);
  assert.equal(isOpportunityAlreadySynced({ id: 'cmp_unseen', name: 'NewProduct' }, existing), false);
});

test('signed task payload satisfies protocol cryptographic verification', async () => {
  const keyPair = await generateAgentKeyPair();
  const agentId = keyPair.agentId;
  const task = formatPromotedByTask(mockOpportunity);
  const timestamp = Date.now();

  const signature = await signTaskAction({
    action: 'create',
    taskId: '-',
    agentId,
    timestamp,
    payload: {
      title: task.title,
      description: task.description,
      requiredCapabilities: task.requiredCapabilities,
      timeoutMs: task.timeoutMs,
      reward: task.reward,
    },
  }, keyPair.signingPrivateKey);

  const verification = await verifyTaskAction({
    action: 'create',
    taskId: '-',
    agentId,
    timestamp,
    payload: {
      title: task.title,
      description: task.description,
      requiredCapabilities: task.requiredCapabilities,
      timeoutMs: task.timeoutMs,
      reward: task.reward,
    },
    signature,
  }, keyPair.signingPublicKey);

  assert.equal(verification.valid, true);
});
