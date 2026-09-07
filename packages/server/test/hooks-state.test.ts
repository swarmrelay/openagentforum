import { afterEach, describe, expect, it } from 'vitest';
import { generateAgentKeyPair, signHookAction } from '@openagentforum/protocol';
import { HookManager } from '../src/hooks/manager.js';
import { HookCipher } from '../src/hooks/cipher.js';
import { STATE_LIMITS } from '../src/hooks/types.js';
import { fixture, HUB } from './hooks-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
async function setup(backend: 'sqlite' | 'd1') { const f = await fixture(backend); cleanup.push(f.close); return f; }

describe.each(['sqlite', 'd1'] as const)('durable hook lifecycle (%s primary CAS)', backend => {
  it('requires owner signatures and reveals no secret in a signed list', async () => {
    const f = await setup(backend);
    const proof = await f.setProof();
    await expect(f.manager.mutate({ ...proof, signature: '0'.repeat(128) })).rejects.toMatchObject({ code: 'invalid_proof' });
    const other = await generateAgentKeyPair();
    await expect(f.manager.mutate({ ...proof, signature: await signHookAction(proof, other.signingPrivateKey) })).rejects.toMatchObject({ code: 'invalid_proof' });
    expect(await f.makeStore().read(f.owner.agentId)).toBeNull();
    await f.manager.mutate(proof);
    const listed = await f.list();
    expect(listed.hooks[0]).toMatchObject({ hookId: proof.hookId, status: 'pending_verification', secretSet: true });
    expect(JSON.stringify(listed)).not.toContain(proof.hook!.secret);
    const row = await f.makeStore().read(f.owner.agentId);
    expect(row!.ciphertext).not.toContain(proof.hook!.secret);
    expect(row!.ciphertext).not.toContain(proof.hook!.url);
    const revision = row!.revision;
    await f.list();
    expect((await f.makeStore().read(f.owner.agentId))!.revision).toBe(revision);
  });

  it('does not let direct API extra properties change the authorized action or owner', async () => {
    const f = await setup(backend);
    await f.activate();
    const otherProof = { action: 'list' as const, agentId: f.sender.agentId, timestamp: f.clock.now };
    const signed = { ...otherProof, signature: await signHookAction(otherProof, f.sender.signingPrivateKey) };
    await expect(f.manager.list(f.owner.agentId, signed)).rejects.toMatchObject({ code: 'invalid_proof' });
    // Deliberately cross the TypeScript boundary to exercise runtime rejection.
    await expect(f.manager.mutate(signed as never)).rejects.toMatchObject({ code: 'invalid_action' });
    expect((await f.list()).hooks[0].status).toBe('active');
  });

  it('bounds applied proofs without evicting fresh replay records, preserving delete capacity', async () => {
    const f = await setup(backend);
    const initial = await f.setProof();
    await f.manager.mutate(initial);
    for (let n = 1; n < STATE_LIMITS.proofs; n++) {
      f.clock.now++;
      await f.manager.mutate(await f.setProof(initial.hook));
    }
    f.clock.now++;
    await expect(f.manager.mutate(await f.setProof(initial.hook))).rejects.toMatchObject({ code: 'proof_budget' });
    expect(await f.manager.mutate(initial)).toMatchObject({ alreadyApplied: true });
    await f.manager.mutate(await f.proof('delete', initial.hookId));
    expect((await f.list()).hooks).toEqual([]);
    f.clock.now++;
    await expect(f.manager.mutate(await f.proof('delete', initial.hookId))).rejects.toMatchObject({ code: 'proof_budget' });
    f.clock.now += 24 * 3600_000;
    expect(await f.manager.mutate(await f.setProof(initial.hook))).toMatchObject({ alreadyApplied: false });
  });

  it('remembers proof replays across restart and deletion for 24 hours without revival', async () => {
    const f = await setup(backend);
    const original = await f.activate();
    f.clock.now++;
    const deletion = await f.proof('delete', original.hookId);
    await f.manager.mutate(deletion);
    await f.restart();
    f.clock.now += 20 * 60_000; // applied replays work beyond the NEW-proof freshness window
    expect(await f.manager.mutate(original)).toMatchObject({ alreadyApplied: true });
    expect(await f.manager.mutate(deletion)).toMatchObject({ alreadyApplied: true });
    expect((await f.list()).hooks).toEqual([]);
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    f.clock.now += 24 * 3600_000;
    await expect(f.manager.mutate(original)).rejects.toMatchObject({ code: 'stale_proof' });
  });

  it('rejects older or same-timestamp new proofs after replacement/delete', async () => {
    const f = await setup(backend);
    const hook = f.spec();
    const old = await f.setProof(hook, f.clock.now);
    const newer = await f.setProof({ ...hook, secret: f.spec().secret }, f.clock.now + 2);
    await f.manager.mutate(newer);
    await expect(f.manager.mutate(old)).rejects.toMatchObject({ code: 'superseded' });
    await expect(f.manager.mutate(await f.proof('delete', newer.hookId, undefined, newer.timestamp))).rejects.toMatchObject({ code: 'superseded' });
    f.clock.now += 3;
    await f.manager.mutate(await f.proof('delete', newer.hookId));
    await expect(f.manager.mutate(old)).rejects.toMatchObject({ code: 'superseded' });
  });

  it('atomically caps concurrent registrations at three and recognizes parallel duplicates', async () => {
    const f = await setup(backend);
    const proofs = await Promise.all([1, 2, 3, 4].map(i => f.setProof(f.spec({ url: `https://receiver.example.net/${i}` }))));
    const results = await Promise.allSettled(proofs.map(proof => f.manager.mutate(proof)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await f.list()).hooks).toHaveLength(3);
    const appliedIndex = results.findIndex(result => result.status === 'fulfilled');
    expect(await Promise.all(Array.from({ length: 4 }, () => f.manager.mutate(proofs[appliedIndex])))).toEqual(Array(4).fill({ alreadyApplied: true, hookId: proofs[appliedIndex].hookId }));
  });

  it('fences verification results against renew, replace, delete, and lease expiry', async () => {
    const f = await setup(backend);
    const original = await f.setProof();
    await f.manager.mutate(original);
    const first = (await f.manager.claim(f.owner.agentId))!;
    f.clock.now++;
    await f.manager.mutate(await f.proof('renew', original.hookId));
    expect(await f.manager.complete(f.owner.agentId, first.jobId, { ok: true, code: 'verified', retryable: false, status: 200 })).toEqual({ applied: false });
    expect((await f.list()).hooks[0].status).toBe('pending_verification');
    const second = (await f.manager.claim(f.owner.agentId))!;
    expect(second.body.nonce).not.toBe(first.body.nonce);
    f.clock.now++;
    await f.manager.mutate(await f.setProof({ ...original.hook!, secret: f.spec().secret }));
    expect(await f.manager.authorizeDispatch(f.owner.agentId, second.jobId)).toBeNull();
    const third = (await f.manager.claim(f.owner.agentId))!;
    f.clock.now++;
    await f.manager.mutate(await f.proof('delete', original.hookId));
    expect(await f.manager.authorizeDispatch(f.owner.agentId, third.jobId)).toBeNull();
    expect(await f.manager.complete(f.owner.agentId, third.jobId, { ok: true, code: 'verified', retryable: false, status: 200 })).toEqual({ applied: false });
    f.clock.now++;
    await f.manager.mutate(await f.setProof(original.hook));
    const fourth = (await f.manager.claim(f.owner.agentId))!;
    await f.restart();
    f.clock.now += STATE_LIMITS.leaseMs;
    expect(await f.manager.complete(f.owner.agentId, fourth.jobId, { ok: true, code: 'verified', retryable: false, status: 200 })).toEqual({ applied: false });
    expect((await f.list()).hooks[0]).toMatchObject({ status: 'disabled', lastError: 'indeterminate' });
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
  });

  it('does not activate on an incorrect egress success and requires a fresh set after expiry', async () => {
    const f = await setup(backend);
    const original = await f.setProof();
    await f.manager.mutate(original);
    const job = (await f.manager.claim(f.owner.agentId))!;
    await f.manager.complete(f.owner.agentId, job.jobId, { ok: true, code: 'delivered', status: 204, retryable: false });
    expect((await f.list()).hooks[0]).toMatchObject({ status: 'disabled', lastError: 'invalid_egress_result' });
    f.clock.now++;
    await expect(f.manager.mutate(await f.proof('renew', original.hookId))).rejects.toMatchObject({ code: 'fresh_set_required' });
    await f.activate(original.hook);
    f.clock.now += 30 * 24 * 3600_000;
    expect((await f.list()).hooks[0]).toMatchObject({ status: 'disabled', lastError: 'expired' });
    await expect(f.manager.mutate(await f.proof('renew', original.hookId))).rejects.toMatchObject({ code: 'fresh_set_required' });
  });

  it('fails closed for wrong keys, hub/owner/revision swaps, and malformed ciphertext', async () => {
    const f = await setup(backend);
    await f.activate();
    const row = (await f.makeStore().read(f.owner.agentId))!;
    const cipher = await HookCipher.create(f.key, HUB);
    await expect(cipher.open(f.sender.agentId, row)).rejects.toMatchObject({ code: 'hook_state_unreadable' });
    await expect(cipher.open(f.owner.agentId, { ...row, revision: row.revision + 1 })).rejects.toMatchObject({ code: 'hook_state_unreadable' });
    await expect(cipher.open(f.owner.agentId, { ...row, ciphertext: row.ciphertext.slice(0, -2) + (row.ciphertext.endsWith('00') ? 'ff' : '00') })).rejects.toMatchObject({ code: 'hook_state_unreadable' });
    const wrongHub = await HookCipher.create(f.key, 'https://other.example');
    await expect(wrongHub.open(f.owner.agentId, row)).rejects.toMatchObject({ code: 'hook_state_unreadable' });
    const wrongKey = await HookCipher.create('a'.repeat(64), HUB);
    await expect(wrongKey.open(f.owner.agentId, row)).rejects.toMatchObject({ code: 'hook_state_unreadable' });
    expect((await f.makeStore().read(f.owner.agentId))!.revision).toBe(row.revision);
  });

  it('bounds CAS retries and does not pretend success when persistence fails', async () => {
    const f = await setup(backend);
    let writes = 0;
    const manager = await HookManager.create({ hub: HUB, encryptionKey: f.key, now: () => f.clock.now, publicKey: async () => f.owner.signingPublicKey, channelAccess: async () => null,
      store: { read: async () => null, compareAndSwap: async () => { writes++; return false; } },
    });
    await expect(manager.mutate(await f.setProof())).rejects.toMatchObject({ code: 'hook_state_busy' });
    expect(writes).toBe(STATE_LIMITS.casAttempts);
  });
});
