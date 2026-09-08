import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHookDispatchBatch, type HookDispatchOptions } from '../src/hooks/dispatcher.js';
import { createHookEgressClient, type HookEgressClient } from '../src/hooks/egress.js';
import { SCAN_DUE_AFTER } from '../src/hooks/due.js';
import { STATE_LIMITS, type HookDispatchJob } from '../src/hooks/types.js';
import { fixture } from './hooks-fixture.js';
import { bytesToHex } from '@openagentforum/protocol';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanup.splice(0)) close(); });
async function setup(backend: 'sqlite' | 'd1') { const f = await fixture(backend); cleanup.push(f.close); return f; }
const verified = { ok: true, code: 'verified', status: 200, retryable: false };
const delivered = { ok: true, code: 'delivered', status: 204, retryable: false };
const success: HookEgressClient = { submit: async job => ({ kind: 'result', duplicate: false, result: job.body.kind === 'verify' ? verified : delivered }) };
function run(f: Awaited<ReturnType<typeof setup>>, extra: Partial<HookDispatchOptions> = {}) {
  return runHookDispatchBatch({ store: f.makeStore(), manager: f.manager, egress: success, now: () => f.clock.now, ...extra });
}

describe.each(['sqlite', 'd1'] as const)('bounded wake dispatcher (%s)', backend => {
  it('scans due metadata only, orders ties and resumes after an unreadable owner without starvation', async () => {
    const f = await setup(backend);
    await f.manager.mutate(await f.setProof());
    const poison = 'agent_0000000000000000';
    f.db.prepare('INSERT INTO wake_hook_state VALUES (?, 1, ?, ?)').run(poison, 'unreadable', f.clock.now - 1);
    f.db.prepare('INSERT INTO wake_hook_state VALUES (?, 1, ?, ?)').run('agent_ffffffffffffffff', 'future', f.clock.now + 1);
    f.db.prepare('INSERT INTO wake_hook_state VALUES (?, 1, ?, NULL)').run('agent_fffffffffffffffe', 'idle');
    const first = await run(f, { limit: 1 });
    expect(first).toMatchObject({ scanned: 1, errors: 1, submitted: 0, nextCursor: { agentId: poison, dueAt: f.clock.now - 1 } });
    await f.restart();
    const second = await run(f, { limit: 1, after: first.nextCursor });
    expect(second).toMatchObject({ scanned: 1, completed: 1, errors: 0 });
    expect((await f.list()).hooks[0].status).toBe('active');
    expect((await run(f, { limit: 1, after: second.nextCursor })).nextCursor).toBeNull();
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${SCAN_DUE_AFTER}`).all(f.clock.now, 0, poison, 1);
    expect(JSON.stringify(plan)).toContain('wake_hook_state_due_page');
    expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
  });

  it('paginates same-time owners and validates scan bounds before querying', async () => {
    const f = await setup(backend);
    for (let n = 1; n <= 4; n++) f.db.prepare('INSERT INTO wake_hook_state VALUES (?, 1, ?, ?)').run(`agent_${n.toString().padStart(16, '0')}`, 'not decrypted by scan', f.clock.now);
    const store = f.makeStore();
    const first = await store.scanDue(f.clock.now, 2);
    const second = await store.scanDue(f.clock.now, 2, first[1]);
    expect([...first, ...second].map(row => row.agentId)).toEqual([1, 2, 3, 4].map(n => `agent_${n.toString().padStart(16, '0')}`));
    expect(Object.keys(first[0]).sort()).toEqual(['agentId', 'dueAt']);
    for (const limit of [0, 51, -1, NaN, 1.5]) await expect(store.scanDue(f.clock.now, limit)).rejects.toMatchObject({ code: 'invalid_due_scan' });
    await expect(store.scanDue(f.clock.now, 1, { dueAt: 0, agentId: "'; DROP TABLE wake_hook_state; --" })).rejects.toMatchObject({ code: 'invalid_due_scan' });
  });

  it('verifies and wakes from durable origin input without including a message payload', async () => {
    const f = await setup(backend);
    await f.manager.mutate(await f.setProof());
    expect(await run(f)).toMatchObject({ claimed: 1, submitted: 1, completed: 1 });
    const record = await f.message(1, 'general', { message: 'private workspace material must never travel in a hint' });
    await f.manager.enqueue(f.owner.agentId, record);
    await f.restart();
    const submit = vi.fn(success.submit);
    expect(await run(f, { egress: { submit } })).toMatchObject({ claimed: 1, completed: 1 });
    expect(submit.mock.calls[0][0].body).toMatchObject({ kind: 'wake', envelopeId: record.id, storedSeq: 1 });
    expect(submit.mock.calls[0][0].body).not.toHaveProperty('payload');
    expect(await run(f)).toMatchObject({ scanned: 0, submitted: 0 });
  });

  it('commits only one claim across overlapping batches', async () => {
    const f = await setup(backend);
    await f.manager.mutate(await f.setProof());
    const submit = vi.fn(success.submit);
    const reports = await Promise.all(Array.from({ length: 4 }, () => run(f, { egress: { submit } })));
    expect(reports.reduce((n, r) => n + r.claimed, 0)).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('reauthorizes after claiming and cancels deletion before any service I/O', async () => {
    const f = await setup(backend);
    const proof = await f.setProof(); await f.manager.mutate(proof);
    const claim = f.manager.claim.bind(f.manager);
    vi.spyOn(f.manager, 'claim').mockImplementation(async id => {
      const result = await claim(id);
      f.clock.now++;
      await f.manager.mutate(await f.proof('delete', proof.hookId));
      return result;
    });
    const submit = vi.fn(success.submit);
    expect(await run(f, { egress: { submit } })).toMatchObject({ claimed: 1, cancelled: 1, submitted: 0 });
    expect(submit).not.toHaveBeenCalled();
  });

  it('replays a lost service response once with the same job and reauthorization', async () => {
    const f = await setup(backend);
    await f.manager.mutate(await f.setProof());
    const submit = vi.fn<HookEgressClient['submit']>()
      .mockResolvedValueOnce({ kind: 'uncertain', code: 'service_timeout', replayable: true })
      .mockResolvedValueOnce({ kind: 'result', duplicate: true, result: verified });
    const authorize = vi.spyOn(f.manager, 'authorizeDispatch');
    expect(await run(f, { egress: { submit } })).toMatchObject({ claimed: 1, submitted: 2, completed: 1 });
    expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0]);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it('cancels a service replay after membership revocation', async () => {
    const f = await setup(backend);
    f.access.set('private', { isPrivate: true, isMember: true });
    await f.activate(f.spec({ channels: ['private'] }));
    await f.manager.enqueue(f.owner.agentId, await f.message(1, 'private', 'ciphertext', true));
    const submit = vi.fn<HookEgressClient['submit']>(async () => {
      f.access.set('private', { isPrivate: true, isMember: false });
      return { kind: 'uncertain', code: 'service_unavailable', replayable: true };
    });
    expect(await run(f, { egress: { submit } })).toMatchObject({ submitted: 1, cancelled: 1, completed: 0 });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('leaves repeated transport uncertainty durable, never reclaims it on restart', async () => {
    const f = await setup(backend);
    await f.manager.mutate(await f.setProof());
    const submit = vi.fn<HookEgressClient['submit']>(async () => ({ kind: 'uncertain', code: 'service_rejected', replayable: true }));
    expect(await run(f, { egress: { submit } })).toMatchObject({ submitted: 2, uncertain: 1, completed: 0 });
    await f.restart();
    expect(await run(f, { egress: { submit } })).toMatchObject({ scanned: 0, submitted: 0 });
    f.clock.now += STATE_LIMITS.leaseMs;
    expect(await run(f, { egress: { submit } })).toMatchObject({ scanned: 1, claimed: 0, submitted: 0 });
    expect((await f.list()).hooks[0]).toMatchObject({ status: 'disabled', lastError: 'indeterminate' });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('only a trusted callback failure permits one deliberate retry with a new job ID', async () => {
    const f = await setup(backend);
    await f.activate();
    await f.manager.enqueue(f.owner.agentId, await f.message(1));
    const submit = vi.fn<HookEgressClient['submit']>(async () => ({ kind: 'result', duplicate: false, result: { ok: false, code: 'http_error', retryable: true, status: 503 } }));
    expect(await run(f, { egress: { submit } })).toMatchObject({ submitted: 1, completed: 1 });
    await f.restart();
    expect(await run(f, { egress: { submit } })).toMatchObject({ submitted: 0 });
    f.clock.now += 5000;
    expect(await run(f, { egress: { submit } })).toMatchObject({ submitted: 1, completed: 1 });
    expect(submit.mock.calls[0][0].jobId).not.toBe(submit.mock.calls[1][0].jobId);
    expect(submit.mock.calls[0][0].body.envelopeId).toBe(submit.mock.calls[1][0].body.envelopeId);
    f.clock.now += 5000;
    expect(await run(f, { egress: { submit } })).toMatchObject({ submitted: 0 });
    expect((await f.list()).hooks[0].failures).toBe(1);
  });

  it('does not retry malformed service JSON or invent completion outcomes', async () => {
    const f = await setup(backend);
    await f.manager.mutate(await f.setProof());
    const send = vi.fn(async () => Response.json({ duplicate: false, result: { ...verified, command: 'untrusted' } }));
    const complete = vi.spyOn(f.manager, 'complete');
    const egress = createHookEgressClient({ endpoint: 'https://egress.example.net/internal/deliver', token: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), fetch: send });
    expect(await run(f, { egress })).toMatchObject({ submitted: 1, uncertain: 1, completed: 0 });
    expect(complete).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not resend or leak data when completion storage fails', async () => {
    const f = await setup(backend);
    await f.manager.mutate(await f.setProof());
    vi.spyOn(f.manager, 'complete').mockRejectedValue(new Error('sensitive database and credential detail'));
    const submit = vi.fn(success.submit);
    const report = await run(f, { egress: { submit } });
    expect(report).toMatchObject({ submitted: 1, errors: 1, completed: 0 });
    expect(JSON.stringify(report)).not.toContain('sensitive');
    await f.restart();
    expect(await run(f, { egress: { submit } })).toMatchObject({ submitted: 0 });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('ignores stale success after replacement and verifies the new generation separately', async () => {
    const f = await setup(backend);
    await f.manager.mutate(await f.setProof());
    const submit: HookEgressClient['submit'] = async () => {
      f.clock.now++;
      await f.manager.mutate(await f.setProof());
      return { kind: 'result', duplicate: false, result: verified };
    };
    expect(await run(f, { egress: { submit } })).toMatchObject({ submitted: 1, completed: 0, cancelled: 1 });
    expect((await f.list()).hooks[0].status).toBe('pending_verification');
    expect(await run(f)).toMatchObject({ completed: 1 });
  });
});

describe('batch admission and failure bounds', () => {
  function fake(count = 8) {
    const entries = Array.from({ length: count }, (_, n) => ({ dueAt: 1, agentId: `agent_${n.toString().padStart(16, '0')}` }));
    const store = { scanDue: vi.fn(async () => entries) };
    const makeJob = (id: string): HookDispatchJob => ({ jobId: crypto.randomUUID(), secret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), url: 'https://receiver.example.net/wake', body: { kind: 'verify', hub: 'https://openagentforum.com', agentId: id, hookId: 'hook_0000000000000000', sentAt: 1, nonce: '' } });
    const jobs = new Map(entries.map(entry => [entry.agentId, makeJob(entry.agentId)]));
    const manager = { claim: vi.fn(async (id: string) => jobs.get(id)!), authorizeDispatch: vi.fn(async (id: string) => jobs.get(id)!), complete: vi.fn(async () => ({ applied: true })) };
    return { store, manager, egress: success, now: () => 1, entries };
  }

  it('bounds concurrent owners and resumes after the admitted prefix on shutdown', async () => {
    const f = fake();
    const signal = new AbortController();
    let active = 0; let peak = 0;
    const releases: (() => void)[] = [];
    const submit: HookEgressClient['submit'] = async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve)); active--;
      return { kind: 'result', duplicate: false, result: verified };
    };
    const pending = runHookDispatchBatch({ ...f, egress: { submit }, concurrency: 2, signal: signal.signal });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    signal.abort(); releases.forEach(release => release());
    expect(await pending).toMatchObject({ visited: 2, submitted: 2, stopped: true, nextCursor: f.entries[1] });
    expect(peak).toBe(2);
    expect(f.manager.claim).toHaveBeenCalledTimes(2);
  });

  it('does not scan when aborted, and leaves unstarted rows behind its continuation on deadline', async () => {
    const f = fake();
    expect(await runHookDispatchBatch({ ...f, signal: AbortSignal.abort() })).toMatchObject({ scanned: 0, stopped: true });
    expect(f.store.scanDue).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const egress = createHookEgressClient({ endpoint: 'https://egress.example.net/internal/deliver', token: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), fetch: async () => new Promise<Response>(() => {}) });
    const pending = runHookDispatchBatch({ ...f, egress, concurrency: 1, maxRunMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ visited: 1, submitted: 1, uncertain: 1, stopped: true, nextCursor: f.entries[0] });
  });

  it('rejects unbounded or unordered adapters, invalid options and sanitized scan failure', async () => {
    const f = fake();
    for (const patch of [{ limit: 51 }, { concurrency: 5 }, { concurrency: 0 }, { maxRunMs: 25001 }]) await expect(runHookDispatchBatch({ ...f, ...patch })).rejects.toBeInstanceOf(Error);
    await expect(runHookDispatchBatch({ ...f, limit: 1 })).rejects.toMatchObject({ code: 'invalid_due_page' });
    f.store.scanDue.mockResolvedValueOnce([...f.entries].reverse());
    await expect(runHookDispatchBatch(f)).rejects.toMatchObject({ code: 'invalid_due_page' });
    f.store.scanDue.mockRejectedValueOnce(new Error('private database URL'));
    await expect(runHookDispatchBatch(f)).rejects.toMatchObject({ message: 'hook_due_unavailable' });
    expect(f.manager.claim).not.toHaveBeenCalled();
  });
});
