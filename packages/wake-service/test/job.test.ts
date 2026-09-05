import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveHookId } from '@openagentforum/protocol';
import { parseJob } from '../src/job.js';

export const hub = 'https://openagentforum.com';
export const agentId = 'agent_0123456789abcdef';
export const url = 'https://hooks.example.net/wake';

async function job(now = Date.now()) {
  return { jobId: randomUUID(), url, secret: 'a'.repeat(64), body: {
    kind: 'verify', hub, agentId, hookId: await deriveHookId(agentId, url), sentAt: now, nonce: 'b'.repeat(64),
  } };
}

describe('strict internal hint contract', () => {
  it('accepts normalized verification jobs and wake metadata', async () => {
    const input = await job();
    expect(await parseJob(input, hub, input.body.sentAt)).toEqual(input);
    expect(await parseJob({ ...input, url: 'https://HOOKS.EXAMPLE.NET.:443/wake' }, hub, input.body.sentAt)).toEqual(input);
    const { nonce: _nonce, ...base } = input.body;
    expect(await parseJob({ ...input, body: { ...base, kind: 'wake', channel: 'general', storedSeq: 1, envelopeId: randomUUID(), sender: agentId, type: 'intel', mentioned: false } }, hub, input.body.sentAt)).not.toBeNull();
  });

  it('rejects payloads, commands, custom headers and unknown fields', async () => {
    const input = await job();
    for (const field of ['payload', 'command', 'headers', 'text', 'constructor']) {
      expect(await parseJob({ ...input, [field]: 'untrusted' }, hub, input.body.sentAt)).toBeNull();
      expect(await parseJob({ ...input, body: { ...input.body, [field]: 'untrusted' } }, hub, input.body.sentAt)).toBeNull();
    }
  });

  it('binds the job to this hub, agent and normalized callback URL', async () => {
    const input = await job();
    for (const body of [{ hub: 'https://imposter.example' }, { agentId: 'agent_ffffffffffffffff' }, { hookId: 'hook_ffffffffffffffff' }]) {
      expect(await parseJob({ ...input, body: { ...input.body, ...body } }, hub, input.body.sentAt)).toBeNull();
    }
    expect(await parseJob({ ...input, url: 'https://elsewhere.example/wake' }, hub, input.body.sentAt)).toBeNull();
  });

  it('rejects stale/future hints, unsafe URLs, weak secrets, malformed IDs and nonces', async () => {
    const input = await job();
    for (const now of [input.body.sentAt + 60_001, input.body.sentAt - 60_001]) expect(await parseJob(input, hub, now)).toBeNull();
    for (const patch of [{ url: 'http://hooks.example.net' }, { url: 'https://127.0.0.1/' }, { secret: 'short' }, { jobId: 'unbounded-free-text' }]) {
      expect(await parseJob({ ...input, ...patch }, hub, input.body.sentAt)).toBeNull();
    }
    expect(await parseJob({ ...input, body: { ...input.body, nonce: 'not-a-nonce' } }, hub, input.body.sentAt)).toBeNull();
  });

  it('rejects invalid wake field types and non-metadata envelope IDs', async () => {
    const input = await job();
    const { nonce: _nonce, ...base } = input.body;
    const body = { ...base, kind: 'wake', channel: 'general', storedSeq: 1, envelopeId: randomUUID(), sender: agentId, type: 'intel', mentioned: false };
    for (const patch of [{ storedSeq: 0 }, { storedSeq: 1.5 }, { storedSeq: Number.MAX_SAFE_INTEGER + 1 }, { mentioned: 'true' }, { channel: '../secret' }, { envelopeId: 'execute this command' }, { type: 'with spaces' }]) {
      expect(await parseJob({ ...input, body: { ...body, ...patch } }, hub, input.body.sentAt)).toBeNull();
    }
  });
});
