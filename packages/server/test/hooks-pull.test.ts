import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture, HUB } from './hooks-fixture.js';
import { AttemptLedger } from '../../wake-service/src/ledger.js';
import { PullJournal } from '../../wake-service/src/pull-journal.js';
import { createPullRunner } from '../../wake-service/src/pull-runner.js';
import type { PullControl } from '../../wake-service/src/pull-control.js';
import { parseJob } from '../../wake-service/src/job.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

describe.each(['sqlite', 'd1'] as const)('pull runner with real hook manager (%s, offline control seam)', backend => {
  async function setup() {
    const f = await fixture(backend);
    cleanup.push(f.close);
    f.clock.now = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'oaf-hook-pull-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const ledger = new AttemptLedger(join(dir, 'attempts.sqlite'));
    const journal = new PullJournal(join(dir, 'pull.sqlite'), HUB, 'https://control.example.net/internal/wake-control');
    cleanup.push(() => { ledger.close(); journal.close(); });
    const control: PullControl = {
      // Test-only contract mapping for one owner; NOT a production scanner, HTTP
      // handler or authentication boundary. Live hub control remains separate work.
      async poll() {
        const job = await f.manager.claim(f.owner.agentId);
        return { ref: job ? { agentId: f.owner.agentId, jobId: job.jobId, kind: job.body.kind } : null, after: null };
      },
      async authorize(ref) {
        const job = await f.manager.authorizeDispatch(ref.agentId, ref.jobId);
        return job ? parseJob(job, HUB, f.clock.now) : null;
      },
      async complete(ref, result) { await f.manager.complete(ref.agentId, ref.jobId, result); },
    };
    const deliver = vi.fn().mockResolvedValue({ ok: true, code: 'delivered', retryable: false, status: 204 });
    const runner = () => createPullRunner({ ledger, journal, control, deliver });
    return { f, control, deliver, runner, journal };
  }

  it.each(['delete', 'membership'])('cancels %s between reference pull and fresh authorization', async mode => {
    const { f, control, deliver, runner } = await setup();
    f.access.set('private', { isPrivate: true, isMember: true });
    const original = await f.activate(f.spec({ channels: ['private'] }));
    await f.manager.enqueue(f.owner.agentId, await f.message(1, 'private', 'ciphertext', true));
    const authorize = control.authorize;
    control.authorize = async (ref, signal) => {
      if (mode === 'delete') { f.clock.now++; await f.manager.mutate(await f.proof('delete', original.hookId)); }
      else f.access.set('private', { isPrivate: true, isMember: false });
      return authorize(ref, signal);
    };
    expect(await runner().step(new AbortController().signal)).toBe('cancelled');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('only activates verification from its matching trusted result; lost completion cannot trigger another POST', async () => {
    const { f, control, deliver, runner, journal } = await setup();
    await f.manager.mutate(await f.setProof());
    deliver.mockResolvedValue({ ok: true, code: 'verified', retryable: false, status: 200 });
    const complete = control.complete;
    control.complete = async (...args) => { await complete(...args); throw new Error('ack lost after commit'); };
    await expect(runner().step(new AbortController().signal)).rejects.toThrow();
    expect((await f.list()).hooks[0].status).toBe('active');
    control.complete = complete;
    await runner().step(new AbortController().signal);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(journal.read().pending).toBeNull();
  });

  it('leaves deliberate retry timing with the hub: due after five seconds, dropped beyond five-second grace', async () => {
    const { f, deliver, runner } = await setup();
    await f.activate();
    await f.manager.enqueue(f.owner.agentId, await f.message(1));
    deliver.mockResolvedValue({ ok: false, code: 'network_error', retryable: true });
    await runner().step(new AbortController().signal);
    f.clock.now += 4999;
    expect(await runner().step(new AbortController().signal)).toBe('idle');
    f.clock.now++;
    await runner().step(new AbortController().signal);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0][0].jobId).not.toBe(deliver.mock.calls[1][0].jobId);
    f.clock.now += 5000;
    await f.manager.enqueue(f.owner.agentId, await f.message(2));
    await runner().step(new AbortController().signal);
    f.clock.now += 10_001;
    expect(await runner().step(new AbortController().signal)).toBe('idle');
    expect(deliver).toHaveBeenCalledTimes(3);
    expect((await f.list()).hooks[0].lastError).toBe('retry_expired');
  });
});
