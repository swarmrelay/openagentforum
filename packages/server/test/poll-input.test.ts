import { describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '@openagentforum/protocol';
import { fitsPollActionInput, POLL_ACTION_LIMITS } from '../src/poll-input.js';
import { pollIngestGate, type PollStore } from '../src/polls-routes.js';

const ballot = (payload: unknown = { pollId: 'p', pollHash: 'a'.repeat(64), choice: 0 }): MessageEnvelope<unknown> => ({
  id: 'b', channel: 'test', sender: 'agent_' + 'a'.repeat(16), type: 'vote', sequence: 1, timestamp: 1,
  signature: 'a'.repeat(128), checksum: 'b'.repeat(64), payload,
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('hosted poll action input', () => {
  it.each(['ASCII', 'UTF-8', 'JSON escapes'])('counts exact payload bytes including %s at the inclusive boundary', mode => {
    const payload = { pollId: 'p'.repeat(256), pollHash: 'a'.repeat(64), choice: 0, justificationRef: '' };
    const space = POLL_ACTION_LIMITS.payloadBytes - bytes(payload);
    const unit = mode === 'UTF-8' ? '界' : mode === 'JSON escapes' ? '\u0001' : 'a';
    const width = bytes(unit) - 2;
    payload.justificationRef = unit.repeat(Math.floor(space / width)) + 'a'.repeat(space % width);
    const envelope = ballot(payload), before = JSON.stringify(envelope);
    expect(bytes(payload)).toBe(1024); expect(fitsPollActionInput(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).toBe(before);
    payload.justificationRef += 'a';
    expect(bytes(payload)).toBe(1025); expect(fitsPollActionInput(envelope)).toBe(false);
    // This is the resource guard; the protocol separately caps reference length.
  });

  it('bounds complete envelopes at 2048 bytes so unsigned metadata cannot carry padding', () => {
    const envelope = { ...ballot(), recipientKeys: { ['agent_' + 'c'.repeat(16)]: '' } };
    envelope.recipientKeys['agent_' + 'c'.repeat(16)] = 'x'.repeat(POLL_ACTION_LIMITS.envelopeBytes - bytes(envelope));
    expect(bytes(envelope)).toBe(2048); expect(fitsPollActionInput(envelope)).toBe(true);
    envelope.recipientKeys['agent_' + 'c'.repeat(16)] += 'x';
    expect(fitsPollActionInput(envelope)).toBe(false);
  });

  it('bounds the complete tree independently of bytes, including metadata and ignored extensions', () => {
    const envelope = { ...ballot(), extension: [] as number[] };
    // Root + 10 envelope fields + 3 payload fields = 14; each array item is a node.
    envelope.extension = Array(18).fill(0);
    expect(bytes(envelope)).toBeLessThan(2048); expect(fitsPollActionInput(envelope)).toBe(true);
    envelope.extension.push(0); expect(fitsPollActionInput(envelope)).toBe(false);
  });

  it.each(['vote', 'close'] as const)('rejects unknown %s payload fields without touching history or registry', async kind => {
    const envelope = kind === 'vote' ? ballot() : { ...ballot(), type: 'poll' as const,
      payload: { kind: 'close', pollId: 'p', pollHash: 'a'.repeat(64) } };
    const touched = vi.fn(() => { throw new Error('history must not be read'); });
    const store: PollStore = { getPoll: touched, candidates: touched, listPolls: touched, withShare: touched,
      publicKey: touched, registeredAt: touched, active: touched };
    for (const field of ['padding', 'constructor', '__proto__', 'kindExtension']) {
      const extra = JSON.parse(`{"${field}":0}`);
      const response = await pollIngestGate(store, { ...envelope, payload: { ...envelope.payload as object, ...extra } }, 'https://relay.test');
      expect(response?.status).toBe(400); expect(response?.headers.get('cache-control')).toBe('no-store');
      expect(await response?.json()).toEqual({ error: 'Poll action exceeds hosted input policy', reason: 'invalid_payload' });
    }
    expect(touched).not.toHaveBeenCalled();
  });

  it('leaves roots, ordinary messages and the encrypted-action refusal to their existing checks', () => {
    expect(fitsPollActionInput({ ...ballot(), type: 'poll', payload: { kind: 'open', description: 'x'.repeat(4000) } })).toBe(true);
    expect(fitsPollActionInput({ ...ballot(), type: 'intel', payload: { padding: 'x'.repeat(4000) } })).toBe(true);
    expect(fitsPollActionInput({ ...ballot(), encrypted: true, payload: 'ciphertext' })).toBe(true);
  });
});
