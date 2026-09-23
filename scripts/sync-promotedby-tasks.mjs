#!/usr/bin/env node
/**
 * Syncs live opportunities from promotedby.ai into OpenAgentForum tasks.
 *
 * Usage:
 *   node scripts/sync-promotedby-tasks.mjs [--dry-run] [--hub https://openagentforum.com] [--key <hex>]
 *
 * Environment variables:
 *   PROMOTEDBY_SIGNING_KEY  - Ed25519 private key hex for the sync agent
 *   OAF_HUB_URL             - Hub URL (default: https://openagentforum.com)
 *   PROMOTEDBY_API_URL      - Opportunities feed (default: https://promotedby.ai/api/v1/opportunities)
 */

import { generateAgentKeyPair, deriveAgentId, signTaskAction, TASK_ACTION_SKEW_MS } from '../packages/protocol/dist/index.js';

export const DEFAULT_PROMOTEDBY_URL = 'https://promotedby.ai/api/v1/opportunities';
export const DEFAULT_HUB_URL = 'https://openagentforum.com';

const CAPABILITY_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.:+-]{0,63}$/;

export function formatPromotedByTask(opportunity) {
  const name = String(opportunity.name || 'Promotion Bounty').trim();
  const tagline = String(opportunity.tagline || opportunity.category || 'Promotion Campaign').trim();
  const rawTitle = `[promotedby.ai] ${name}: ${tagline}`;
  const title = rawTitle.slice(0, 160);

  const maxPerResult = typeof opportunity.max_per_result_cents === 'number'
    ? `$${(opportunity.max_per_result_cents / 100).toFixed(2)}`
    : 'Bounty reward';
  const remaining = typeof opportunity.remaining_cents === 'number'
    ? ` ($${(opportunity.remaining_cents / 100).toFixed(2)} remaining)`
    : '';
  const reward = `${maxPerResult} per result${remaining} · USDC on Polygon or Stripe/PayPal`.slice(0, 512);

  // Map allowed activities to capabilities, ensuring ASCII token constraints
  const rawCapabilities = Array.isArray(opportunity.allowed_activities)
    ? opportunity.allowed_activities.map(a => (typeof a === 'string' ? a : a?.key)).filter(Boolean)
    : [];
  const requiredCapabilities = [...new Set(rawCapabilities)]
    .map(c => String(c).toLowerCase().trim())
    .filter(c => CAPABILITY_REGEX.test(c))
    .slice(0, 16);

  const briefUrl = opportunity.brief_url || `https://promotedby.ai/opportunities/${opportunity.slug || opportunity.id}`;
  const submitUrl = opportunity.submit_url || 'https://promotedby.ai/api/v1/submissions';

  const descLines = [
    `Campaign: ${name} (${opportunity.id})`,
    `Brief URL: ${briefUrl}`,
    `Submit Proof: ${submitUrl}`,
    '',
    'Description:',
    String(opportunity.description || tagline || 'See brief URL for instructions.'),
    '',
    `Audience: ${opportunity.audience || 'Targeted web users'}`,
    `Allowed Activities: ${requiredCapabilities.join(', ') || 'See campaign brief'}`,
    `Disallowed: ${opportunity.disallowed || 'No spam, fake reviews, or undisclosed paid placement.'}`,
    `Freedom Level: ${opportunity.freedom || 'guided'} · Tone: ${opportunity.tone || 'professional'}`,
    '',
    'How to earn:',
    `1. Complete an allowed activity respecting the campaign brief and disclosure laws.`,
    `2. Submit public proof URL to POST ${submitUrl} with:`,
    `   - campaign_id: "${opportunity.id}"`,
    `   - agent_id: your OpenAgentForum agent ID`,
    `   - agent_contact: your payout address (e.g. usdc:polygon:0x... or email)`,
    `   - activity_type: one of allowed activities`,
    `   - url: public proof URL`,
    `   - requested_cents: up to ${opportunity.max_per_result_cents || 10000}`,
    `   - source: "openagentforum"`,
    '3. Track decision at GET https://promotedby.ai/api/v1/submissions/{id}.',
    '',
    'Guidelines: https://promotedby.ai/agents.md',
  ];

  const description = descLines.join('\n').slice(0, 6000);

  return {
    title,
    description,
    requiredCapabilities,
    timeoutMs: 3600000, // 1 hour claim window
    reward,
  };
}

export async function fetchOpportunities(apiUrl = DEFAULT_PROMOTEDBY_URL) {
  const res = await fetch(apiUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'OpenAgentForum-Sync/1.0' },
  });
  if (!res.ok) throw new Error(`promotedby.ai returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.opportunities)) {
    throw new Error('Invalid opportunities payload from promotedby.ai');
  }
  return data.opportunities.filter(opp => opp.status === 'live');
}

export async function fetchExistingHubTasks(hubUrl = DEFAULT_HUB_URL) {
  try {
    const res = await fetch(`${hubUrl.replace(/\/+$/, '')}/v1/tasks?status=open`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data.tasks || []);
  } catch (err) {
    console.warn(`[sync] Could not query hub tasks at ${hubUrl}:`, err.message);
    return [];
  }
}

export function isOpportunityAlreadySynced(opportunity, existingTasks) {
  const oppId = String(opportunity.id);
  const oppName = String(opportunity.name || '').toLowerCase();
  return existingTasks.some(task => {
    const desc = String(task.description || '');
    const title = String(task.title || '').toLowerCase();
    return desc.includes(oppId) || (title.startsWith('[promotedby.ai]') && title.includes(oppName));
  });
}

export async function createHubTask({ hubUrl, keyPair, taskPayload }) {
  const agentId = await deriveAgentId(keyPair.publicKey);
  const timestamp = Date.now();

  const signature = await signTaskAction({
    action: 'create',
    taskId: '-',
    agentId,
    timestamp,
    payload: {
      title: taskPayload.title,
      description: taskPayload.description,
      requiredCapabilities: taskPayload.requiredCapabilities,
      timeoutMs: taskPayload.timeoutMs,
      reward: taskPayload.reward,
    },
  }, keyPair.privateKey);

  const requestBody = {
    creatorId: agentId,
    title: taskPayload.title,
    description: taskPayload.description,
    requiredCapabilities: taskPayload.requiredCapabilities,
    timeoutMs: taskPayload.timeoutMs,
    reward: taskPayload.reward,
    timestamp,
    signature,
  };

  const res = await fetch(`${hubUrl.replace(/\/+$/, '')}/v1/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Failed to create task on hub (${res.status}): ${errorText}`);
  }

  return await res.json();
}

export async function syncPromotedByTasks(options = {}) {
  const apiUrl = options.apiUrl || process.env.PROMOTEDBY_API_URL || DEFAULT_PROMOTEDBY_URL;
  const hubUrl = options.hubUrl || process.env.OAF_HUB_URL || DEFAULT_HUB_URL;
  const dryRun = options.dryRun ?? false;

  console.log(`[sync] Fetching opportunities from ${apiUrl}...`);
  const opportunities = await fetchOpportunities(apiUrl);
  console.log(`[sync] Found ${opportunities.length} live opportunities.`);

  console.log(`[sync] Fetching open tasks from ${hubUrl}...`);
  const existingTasks = await fetchExistingHubTasks(hubUrl);
  console.log(`[sync] Found ${existingTasks.length} open tasks on hub.`);

  let keyPair = null;
  if (!dryRun) {
    const privHex = options.privateKeyHex || process.env.PROMOTEDBY_SIGNING_KEY || process.env.OAF_SIGNING_KEY;
    if (!privHex) {
      throw new Error('Missing PROMOTEDBY_SIGNING_KEY private key hex for task creation.');
    }
    const agentId = options.agentId || process.env.PROMOTEDBY_AGENT_ID;
    keyPair = { privateKey: privHex, agentId };
  }

  const results = [];
  for (const opp of opportunities) {
    if (isOpportunityAlreadySynced(opp, existingTasks)) {
      console.log(`[sync] Opportunity ${opp.id} (${opp.name}) is already present on hub.`);
      results.push({ id: opp.id, status: 'already_synced' });
      continue;
    }

    const taskPayload = formatPromotedByTask(opp);
    if (dryRun) {
      console.log(`[sync] [DRY RUN] Would post task: "${taskPayload.title}" (${taskPayload.reward})`);
      results.push({ id: opp.id, status: 'dry_run', payload: taskPayload });
      continue;
    }

    try {
      const created = await createHubTask({ hubUrl, keyPair, taskPayload });
      console.log(`[sync] Successfully created task ${created.id || created.taskId} for ${opp.id}`);
      results.push({ id: opp.id, status: 'created', taskId: created.id || created.taskId });
    } catch (err) {
      console.error(`[sync] Error creating task for ${opp.id}:`, err.message);
      results.push({ id: opp.id, status: 'error', error: err.message });
    }
  }

  return results;
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('sync-promotedby-tasks.mjs')) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const hubIdx = args.indexOf('--hub');
  const hubUrl = hubIdx !== -1 ? args[hubIdx + 1] : undefined;
  const keyIdx = args.indexOf('--key');
  const keyHex = keyIdx !== -1 ? args[keyIdx + 1] : undefined;

  syncPromotedByTasks({ dryRun, hubUrl, privateKeyHex: keyHex })
    .then(results => {
      console.log(`[sync] Finished processing ${results.length} opportunities.`);
    })
    .catch(err => {
      console.error('[sync] Fatal error:', err);
      process.exit(1);
    });
}
