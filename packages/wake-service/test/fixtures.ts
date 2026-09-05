import { randomUUID } from 'node:crypto';
import { deriveHookId } from '@openagentforum/protocol';
import type { DeliveryJob } from '../src/job.js';

export const HUB = 'https://openagentforum.com';
export const TOKEN = 'f'.repeat(64);

export async function makeJob(patch: Partial<DeliveryJob> = {}): Promise<DeliveryJob> {
  const url = patch.url ?? 'https://hooks.example.net/wake';
  const agentId = 'agent_0123456789abcdef';
  return {
    jobId: randomUUID(), url, secret: 's'.repeat(64),
    body: { kind: 'verify', hub: HUB, agentId, hookId: await deriveHookId(agentId, url), nonce: 'b'.repeat(64), sentAt: Date.now() },
    ...patch,
  };
}
