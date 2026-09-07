import { afterEach, describe, expect, it } from 'vitest';
import { STATE_LIMITS } from '../src/hooks/types.js';
import { fixture } from './hooks-fixture.js';
import { parseJob } from '../../wake-service/src/job.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
async function setup(backend: 'sqlite' | 'd1') { const f = await fixture(backend); cleanup.push(f.close); return f; }
const delivered = { ok: true, code: 'delivered', status: 204, retryable: false };

describe.each(['sqlite', 'd1'] as const)('durable pending work (%s)', backend => {
  it('coalesces to the newest stored record with OR mentions, survives restart and suppresses old input', async () => {
    const f = await setup(backend);
    await f.activate();
    const first = await f.message(1, 'general', { message: f.owner.agentId });
    const second = await f.message(2);
    await f.manager.enqueue(f.owner.agentId, first);
    await f.manager.enqueue(f.owner.agentId, second);
    await f.restart();
    const job = (await f.manager.claim(f.owner.agentId))!;
    expect(await parseJob(job, job.body.hub, f.clock.now)).toEqual(job);
    expect(job.body).toMatchObject({ kind: 'wake', storedSeq: 2, envelopeId: second.id, mentioned: true });
    expect(job.body).not.toHaveProperty('payload');
    expect(await f.manager.authorizeDispatch(f.owner.agentId, job.jobId)).toEqual(job);
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    await f.manager.complete(f.owner.agentId, job.jobId, delivered);
    expect(await f.manager.enqueue(f.owner.agentId, first)).toMatchObject({ queued: 0 });
    await f.manager.enqueue(f.owner.agentId, await f.message(3));
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    f.clock.now += 5000;
    expect((await f.manager.claim(f.owner.agentId))!.body.storedSeq).toBe(3);
  });

  it('allows only one concurrent claim and cancels when deletion wins an access-check race', async () => {
    const f = await setup(backend);
    const original = await f.activate();
    await f.manager.enqueue(f.owner.agentId, await f.message(1));
    const claims = await Promise.all(Array.from({ length: 4 }, () => f.manager.claim(f.owner.agentId)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const job = claims.find(Boolean)!;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const { HookManager } = await import('../src/hooks/manager.js');
    const racing = await HookManager.create({ hub: job.body.hub, encryptionKey: f.key, store: f.makeStore(), now: () => f.clock.now,
      publicKey: async id => f.publicKeys.get(id) ?? null,
      channelAccess: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { isPrivate: false, isMember: false }; },
    });
    const authorization = racing.authorizeDispatch(f.owner.agentId, job.jobId);
    await waiting;
    f.clock.now++;
    await f.manager.mutate(await f.proof('delete', original.hookId));
    release();
    expect(await authorization).toBeNull();
  });

  it('permits one explicit retry with a new ID, rechecks access, and never retries an ambiguous send', async () => {
    const f = await setup(backend);
    await f.activate();
    await f.manager.enqueue(f.owner.agentId, await f.message(1));
    const first = (await f.manager.claim(f.owner.agentId))!;
    await f.manager.complete(f.owner.agentId, first.jobId, { ok: false, code: 'network_error', retryable: true });
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    await f.restart();
    f.clock.now += 5000;
    const retry = (await f.manager.claim(f.owner.agentId))!;
    expect(retry.jobId).not.toBe(first.jobId);
    expect(retry.body.envelopeId).toBe(first.body.envelopeId);
    await f.manager.complete(f.owner.agentId, retry.jobId, { ok: false, code: 'http_error', status: 503, retryable: true });
    f.clock.now += 5000;
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    expect((await f.list()).hooks[0].failures).toBe(1);
    await f.manager.enqueue(f.owner.agentId, await f.message(2));
    const uncertain = (await f.manager.claim(f.owner.agentId))!;
    await f.restart();
    f.clock.now += STATE_LIMITS.leaseMs;
    expect(await f.manager.authorizeDispatch(f.owner.agentId, uncertain.jobId)).toBeNull();
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    expect((await f.list()).hooks[0]).toMatchObject({ failures: 2, lastError: 'indeterminate' });
  });

  it('does not turn arbitrary retryable flags or verification failures into extra callbacks', async () => {
    const f = await setup(backend);
    const proof = await f.setProof();
    await f.manager.mutate(proof);
    const verify = (await f.manager.claim(f.owner.agentId))!;
    await f.manager.complete(f.owner.agentId, verify.jobId, { ok: false, code: 'network_error', retryable: true });
    f.clock.now += 5000;
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    expect((await f.list()).hooks[0].status).toBe('disabled');
    await f.activate(proof.hook);
    await f.manager.enqueue(f.owner.agentId, await f.message(1));
    const wake = (await f.manager.claim(f.owner.agentId))!;
    await f.manager.complete(f.owner.agentId, wake.jobId, { ok: false, code: 'indeterminate', retryable: true });
    f.clock.now += 5000;
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
  });

  it('drops retries and queued verification that missed their bounded lifetime', async () => {
    const f = await setup(backend);
    await f.activate();
    await f.manager.enqueue(f.owner.agentId, await f.message(1));
    const wake = (await f.manager.claim(f.owner.agentId))!;
    await f.manager.complete(f.owner.agentId, wake.jobId, { ok: false, code: 'timeout', retryable: true });
    f.clock.now += 10_001;
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    expect((await f.list()).hooks[0].lastError).toBe('retry_expired');
    await f.manager.mutate(await f.setProof(f.spec({ url: 'https://receiver.example.net/second' })));
    f.clock.now += STATE_LIMITS.queuedMs + 1;
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    expect((await f.list()).hooks.find(hook => hook.url.endsWith('/second'))!.disabledReason).toBe('verification_expired');
  });

  it('never expands wildcard into private channels, and drops revoked private membership at claim or dispatch', async () => {
    const f = await setup(backend);
    f.access.set('private', { isPrivate: true, isMember: true });
    await f.activate(f.spec({ channels: ['*'] }));
    const privateRecord = await f.message(1, 'private', 'ciphertext', true);
    expect(await f.manager.enqueue(f.owner.agentId, privateRecord)).toMatchObject({ queued: 0 });
    f.clock.now++;
    await f.activate(f.spec({ channels: ['private'], mentionsOnly: true }));
    expect(await f.manager.enqueue(f.owner.agentId, privateRecord)).toMatchObject({ queued: 1 });
    const job = (await f.manager.claim(f.owner.agentId))!;
    expect(job.body.mentioned).toBe(false);
    f.access.set('private', { isPrivate: true, isMember: false });
    expect(await f.manager.authorizeDispatch(f.owner.agentId, job.jobId)).toBeNull();
    expect((await f.list()).hooks[0]).toMatchObject({ channels: [], lastError: 'channel_access_removed' });
    f.clock.now++;
    f.access.set('private', { isPrivate: true, isMember: true });
    await f.activate(f.spec({ channels: ['private'] }));
    await f.manager.enqueue(f.owner.agentId, await f.message(2, 'private', 'ciphertext', true));
    f.access.set('private', { isPrivate: true, isMember: false });
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
  });

  it('invalidates pending wake work after delete or replacement even with a stale completion', async () => {
    const f = await setup(backend);
    const original = await f.activate();
    await f.manager.enqueue(f.owner.agentId, await f.message(1));
    const wake = (await f.manager.claim(f.owner.agentId))!;
    f.clock.now++;
    await f.manager.mutate(await f.proof('delete', original.hookId));
    expect(await f.manager.authorizeDispatch(f.owner.agentId, wake.jobId)).toBeNull();
    expect(await f.manager.complete(f.owner.agentId, wake.jobId, delivered)).toEqual({ applied: false });
    f.clock.now++;
    await f.manager.mutate(await f.setProof(original.hook));
    expect((await f.manager.claim(f.owner.agentId))!.body.kind).toBe('verify');
  });

  it('disables after ten consecutive final failures and resets the failure run on success', async () => {
    const f = await setup(backend);
    await f.activate();
    for (let seq = 1; seq <= 11; seq++) {
      f.clock.now += 5000;
      await f.manager.enqueue(f.owner.agentId, await f.message(seq));
      const wake = (await f.manager.claim(f.owner.agentId))!;
      await f.manager.complete(f.owner.agentId, wake.jobId, seq === 1 ? delivered : { ok: false, code: 'http_error', status: 400, retryable: false });
    }
    expect((await f.list()).hooks[0]).toMatchObject({ status: 'disabled', failures: 10, disabledReason: 'consecutive_failures' });
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
  });

  it('preserves the hourly attempt cap across restart, rotation, delete/recreate and clock rollback', async () => {
    const f = await setup(backend);
    const original = await f.activate(); // verification consumes one of 600 attempts
    for (let seq = 1; seq < 600; seq++) {
      f.clock.now += 5000;
      await f.manager.enqueue(f.owner.agentId, await f.message(seq));
      const job = await f.manager.claim(f.owner.agentId);
      expect(job).not.toBeNull();
      await f.manager.complete(f.owner.agentId, job!.jobId, delivered);
    }
    expect((await f.list()).hooks[0].paused).toBe(true);
    f.clock.now++;
    await f.manager.mutate(await f.setProof({ ...original.hook!, secret: f.spec().secret }));
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    f.clock.now++;
    await f.manager.mutate(await f.proof('delete', original.hookId));
    f.clock.now++;
    await f.manager.mutate(await f.setProof(original.hook));
    await f.restart();
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    const savedNow = f.clock.now;
    f.clock.now -= 3600_000;
    expect(await f.manager.claim(f.owner.agentId)).toBeNull();
    f.clock.now = Math.ceil(savedNow / 3600_000) * 3600_000;
    // Pending verification may age out while paused; a fresh signed set can
    // now verify using the new hour, but it cannot erase the old hour's cap.
    await f.manager.mutate(await f.setProof(original.hook));
    expect((await f.manager.claim(f.owner.agentId))!.body.kind).toBe('verify');
  }, 30_000);

  it('bounds wildcard channel slots and rejects tampered records without queuing payload data', async () => {
    const f = await setup(backend);
    await f.activate(f.spec({ channels: ['*'] }));
    for (let n = 0; n < STATE_LIMITS.channelsPerHook; n++) expect(await f.manager.enqueue(f.owner.agentId, await f.message(1, n === 0 ? '__proto__' : `ch-${n}`))).toMatchObject({ queued: 1 });
    expect(await f.manager.enqueue(f.owner.agentId, await f.message(1, 'overflow'))).toEqual({ queued: 0, limited: true });
    const record = await f.message(2, 'ch-1');
    await expect(f.manager.enqueue(f.owner.agentId, { ...record, payload: { message: 'forged' } })).rejects.toMatchObject({ code: 'invalid_record' });
    expect((await f.manager.claim(f.owner.agentId))!.body.channel).toBe('__proto__');
  });
});
