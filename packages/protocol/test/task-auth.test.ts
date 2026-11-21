/**
 * verifyTaskAction refusal paths (#30).
 *
 * task-auth.ts carries no test file, yet every branch in it is a security
 * boundary: create/claim/submit are identity-bearing writes, and a verifier that
 * is merely permissive lets a captured proof be replayed onto a different task
 * or a different result. Each test below pins one refusal, plus the positive
 * cases that prove the refusals are not firing by accident.
 *
 * The verifier takes `now` explicitly (`opts.now`), so none of this depends on
 * the wall clock.
 */
import { describe, expect, it } from 'vitest';
import { generateAgentKeyPair } from '../src/crypto.js';
import {
  TASK_ACTION_SKEW_MS,
  signTaskAction,
  taskActionString,
  verifyTaskAction,
} from '../src/task-auth.js';

const NOW = 1_800_000_000_000;

/** A signed action for the given params, plus the key that signed it. */
async function signed(over: Partial<Parameters<typeof signTaskAction>[0]> = {}) {
  const agent = await generateAgentKeyPair();
  const params = {
    action: 'claim' as const,
    taskId: 'task_abc',
    agentId: agent.agentId,
    timestamp: NOW,
    payload: {} as Record<string, unknown>,
    ...over,
  };
  const signature = await signTaskAction(params, agent.signingPrivateKey);
  return { agent, params, signature };
}

describe('verifyTaskAction: the positive cases the refusals must not break', () => {
  it('accepts a claim signed by the key behind agentId', async () => {
    const { agent, params, signature } = await signed();
    const out = await verifyTaskAction({ ...params, signature }, agent.signingPublicKey, { now: NOW });
    expect(out).toEqual({ valid: true });
  });

  it('accepts create with taskId "-" and a content-bearing payload', async () => {
    const { agent, params, signature } = await signed({
      action: 'create',
      taskId: '-',
      payload: { title: 't', description: 'd', requiredCapabilities: [], timeoutMs: 1000, reward: null },
    });
    const out = await verifyTaskAction({ ...params, signature }, agent.signingPublicKey, { now: NOW });
    expect(out.valid).toBe(true);
  });

  it('accepts submit carrying a resultPayload', async () => {
    const { agent, params, signature } = await signed({
      action: 'submit',
      payload: { resultPayload: { verdict: 'VALIDATED' } },
    });
    const out = await verifyTaskAction({ ...params, signature }, agent.signingPublicKey, { now: NOW });
    expect(out.valid).toBe(true);
  });
});

describe('verifyTaskAction: content binding (replay resistance)', () => {
  it('rejects a proof replayed onto a different taskId', async () => {
    const { agent, params, signature } = await signed();
    const out = await verifyTaskAction(
      { ...params, taskId: 'task_other', signature },
      agent.signingPublicKey,
      { now: NOW }
    );
    expect(out.valid).toBe(false);
    expect(out.error).toBe('signature does not verify');
  });

  it('rejects a proof replayed with a different payload', async () => {
    const { agent, params, signature } = await signed({
      action: 'submit',
      payload: { resultPayload: { verdict: 'VALIDATED' } },
    });
    const out = await verifyTaskAction(
      { ...params, payload: { resultPayload: { verdict: 'CONTRADICTED' } }, signature },
      agent.signingPublicKey,
      { now: NOW }
    );
    expect(out.valid).toBe(false);
    expect(out.error).toBe('signature does not verify');
  });

  it('rejects a proof replayed with a different action', async () => {
    const { agent, params, signature } = await signed();
    const out = await verifyTaskAction(
      { ...params, action: 'submit', signature },
      agent.signingPublicKey,
      { now: NOW }
    );
    expect(out.valid).toBe(false);
  });
});

describe('verifyTaskAction: clock window', () => {
  it('rejects a timestamp older than the skew window', async () => {
    const { agent, params, signature } = await signed({ timestamp: NOW - TASK_ACTION_SKEW_MS - 1 });
    const out = await verifyTaskAction({ ...params, signature }, agent.signingPublicKey, { now: NOW });
    expect(out).toEqual({ valid: false, error: 'timestamp outside the allowed window' });
  });

  it('rejects a timestamp further in the future than the skew window', async () => {
    const { agent, params, signature } = await signed({ timestamp: NOW + TASK_ACTION_SKEW_MS + 1 });
    const out = await verifyTaskAction({ ...params, signature }, agent.signingPublicKey, { now: NOW });
    expect(out.valid).toBe(false);
    expect(out.error).toMatch(/outside the allowed window/);
  });

  it('accepts exactly at the skew boundary', async () => {
    const { agent, params, signature } = await signed({ timestamp: NOW - TASK_ACTION_SKEW_MS });
    const out = await verifyTaskAction({ ...params, signature }, agent.signingPublicKey, { now: NOW });
    expect(out.valid).toBe(true);
  });

  it('rejects a non-finite timestamp before attempting any crypto', async () => {
    const { agent, params, signature } = await signed({ timestamp: NaN });
    const out = await verifyTaskAction({ ...params, signature }, agent.signingPublicKey, { now: NOW });
    expect(out).toEqual({ valid: false, error: 'timestamp outside the allowed window' });
  });

  it('honours a caller-supplied skew', async () => {
    const { agent, params, signature } = await signed({ timestamp: NOW - 10_000 });
    const strict = await verifyTaskAction({ ...params, signature }, agent.signingPublicKey, { now: NOW, skewMs: 5_000 });
    const loose = await verifyTaskAction({ ...params, signature }, agent.signingPublicKey, { now: NOW, skewMs: 60_000 });
    expect(strict.valid).toBe(false);
    expect(loose.valid).toBe(true);
  });
});

describe('verifyTaskAction: signature encoding is one form only', () => {
  it('rejects an uppercase hex signature', async () => {
    const { agent, params, signature } = await signed();
    const out = await verifyTaskAction(
      { ...params, signature: signature.toUpperCase() },
      agent.signingPublicKey,
      { now: NOW }
    );
    expect(out).toEqual({ valid: false, error: 'signature must be 128 lowercase hex characters' });
  });

  it('rejects a signature of the wrong length', async () => {
    const { agent, params, signature } = await signed();
    const out = await verifyTaskAction({ ...params, signature: signature.slice(0, 126) }, agent.signingPublicKey, { now: NOW });
    expect(out.valid).toBe(false);
    expect(out.error).toMatch(/128 lowercase hex/);
  });

  it('rejects a signature with non-hex characters', async () => {
    const { agent, params, signature } = await signed();
    const tampered = signature.slice(0, 127) + 'z';
    const out = await verifyTaskAction({ ...params, signature: tampered }, agent.signingPublicKey, { now: NOW });
    expect(out.valid).toBe(false);
    expect(out.error).toMatch(/128 lowercase hex/);
  });
});

describe('verifyTaskAction: identity binding', () => {
  it('rejects when agentId is not the fingerprint of the supplied key', async () => {
    const signer = await generateAgentKeyPair();
    const impostor = await generateAgentKeyPair();
    const params = { action: 'claim' as const, taskId: 't', agentId: signer.agentId, timestamp: NOW, payload: {} };
    const signature = await signTaskAction(params, signer.signingPrivateKey);
    // The signature is genuine for the signer, but the verifier is handed a
    // different public key: agentId cannot be that key's fingerprint.
    const out = await verifyTaskAction({ ...params, signature }, impostor.signingPublicKey, { now: NOW });
    expect(out.valid).toBe(false);
    expect(out.error).toBe('agentId is not the fingerprint of this key');
  });

  it('returns the thrown message instead of propagating a malformed key', async () => {
    const { agent, params, signature } = await signed();
    const out = await verifyTaskAction({ ...params, signature }, 'not-a-key', { now: NOW });
    expect(out.valid).toBe(false);
    expect(typeof out.error).toBe('string');
    expect((out.error as string).length).toBeGreaterThan(0);
  });
});

describe('taskActionString: the signed string is unambiguous', () => {
  it('binds action, taskId, agentId, timestamp and the payload checksum, in that order', async () => {
    const { agent, params } = await signed();
    const str = await taskActionString(params);
    const parts = str.split('|');
    expect(parts[0]).toBe('task');
    expect(parts[1]).toBe('claim');
    expect(parts[2]).toBe('task_abc');
    expect(parts[3]).toBe(agent.agentId);
    expect(parts[4]).toBe(String(NOW));
    expect(parts[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(parts.length).toBe(6);
  });

  it('changes when only the payload changes', async () => {
    const a = await taskActionString({ action: 'submit', taskId: 't', agentId: 'agent_x', timestamp: NOW, payload: { resultPayload: { v: 1 } } });
    const b = await taskActionString({ action: 'submit', taskId: 't', agentId: 'agent_x', timestamp: NOW, payload: { resultPayload: { v: 2 } } });
    expect(a).not.toBe(b);
  });

  it('is independent of payload key order, because the checksum canonicalizes', async () => {
    const a = await taskActionString({ action: 'create', taskId: '-', agentId: 'agent_x', timestamp: NOW, payload: { title: 't', description: 'd' } });
    const b = await taskActionString({ action: 'create', taskId: '-', agentId: 'agent_x', timestamp: NOW, payload: { description: 'd', title: 't' } });
    expect(a).toBe(b);
  });
});
