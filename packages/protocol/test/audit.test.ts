import { describe, it, expect } from 'vitest';
import { generateAgentKeyPair, signEnvelope, auditChannel } from '../src/index.js';

describe('auditChannel: replay a record and expose what a feed hides', () => {
  it('verifies, detects gaps, reuse, tampering, and unknown senders', async () => {
    const alice = await generateAgentKeyPair();
    const bob = await generateAgentKeyPair();
    const keys: Record<string, string> = { [alice.agentId]: alice.signingPublicKey, [bob.agentId]: bob.signingPublicKey };
    const mk = (k: any, sequence: number, message: string) =>
      signEnvelope({ channel: 'general', sender: k.agentId, type: 'intel', sequence, payload: { message } }, k.signingPrivateKey);

    // alice: 0,1,3 (2 is missing); bob: 0 twice (counter reset)
    const a0 = await mk(alice, 0, 'a0');
    const a1 = await mk(alice, 1, 'a1');
    const a3 = await mk(alice, 3, 'a3');
    const b0 = await mk(bob, 0, 'b0');
    const b0b = await mk(bob, 0, 'b0 again');
    // tampered: payload swapped after signing
    const bad = { ...(await mk(alice, 4, 'honest')), payload: { message: 'tampered' } };
    // stranger nobody can resolve
    const ghost = await mk(await generateAgentKeyPair(), 0, 'ghost');

    const report = await auditChannel('general', [a0, a1, a3, b0, b0b, bad, ghost], async (s) => keys[s] ?? null);

    expect(report.total).toBe(7);
    expect(report.verified).toBe(5);
    expect(report.failed.map((f) => f.id).sort()).toEqual([bad.id, ghost.id].sort());
    expect(report.failed.find((f) => f.id === bad.id)?.error).toMatch(/checksum/i);
    expect(report.unknownSenders).toEqual([ghost.sender]);
    expect(report.gaps).toEqual([{ sender: alice.agentId, observedMin: 0, observedMax: 3, missing: [2] }]);
    expect(report.reuse).toEqual([{ sender: bob.agentId, sequence: 0, ids: [b0.id, b0b.id] }]);
    expect(report.complete).toBe(false);
  });

  it('reports a clean record as complete', async () => {
    const k = await generateAgentKeyPair();
    const envs = await Promise.all([0, 1, 2].map((n) => signEnvelope({ channel: 'general', sender: k.agentId, type: 'intel', sequence: n, payload: { n } }, k.signingPrivateKey)));
    const report = await auditChannel('general', envs, async () => k.signingPublicKey);
    expect(report.complete).toBe(true);
    expect(report.gaps).toEqual([]);
  });

  it('does not call a record complete when an author reused a counter (#49)', async () => {
    const k = await generateAgentKeyPair();
    const mk = (n: number, msg: string) => signEnvelope({ channel: 'general', sender: k.agentId, type: 'intel', sequence: n, payload: { msg } }, k.signingPrivateKey);
    const envs = [await mk(0, 'first'), await mk(1, 'second'), await mk(1, 'second again')];
    const report = await auditChannel('general', envs, async () => k.signingPublicKey);
    expect(report.failed).toEqual([]);
    expect(report.gaps).toEqual([]);
    expect(report.reuse.length).toBe(1);
    expect(report.complete).toBe(false);
  });
});
