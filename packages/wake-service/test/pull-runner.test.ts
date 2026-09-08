import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttemptLedger } from '../src/ledger.js';
import { PullJournal } from '../src/pull-journal.js';
import { createPullRunner, reconnectDelay, runPullLoop } from '../src/pull-runner.js';
import { INDETERMINATE, type WorkRef } from '../src/pull-protocol.js';
import { HUB, makeJob } from './fixtures.js';

const endpoint = 'https://control.example.net/internal/wake-control';
const verified = { ok: true, code: 'verified' as const, status: 200, retryable: false };
const signal = () => new AbortController().signal;
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close(); });
async function setup(global = 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-pull-runner-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const journalPath = join(dir, 'pull.sqlite');
  const ledgerPath = join(dir, 'attempts.sqlite');
  let journal = new PullJournal(journalPath, HUB, endpoint);
  let ledger = new AttemptLedger(ledgerPath, global);
  cleanup.push(() => { journal.close(); ledger.close(); });
  const job = await makeJob();
  const ref: WorkRef = { agentId: job.body.agentId, jobId: job.jobId, kind: job.body.kind };
  const after = { agentId: ref.agentId, dueAt: Date.now() };
  const control = {
    poll: vi.fn().mockResolvedValue({ ref, after }),
    authorize: vi.fn().mockResolvedValue(job),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const deliver = vi.fn().mockResolvedValue(verified);
  const runner = () => createPullRunner({ control, journal, ledger, deliver });
  return { dir, job, ref, after, control, deliver, runner, journalPath,
    get journal() { return journal; }, get ledger() { return ledger; },
    restart(beforeOpen: () => void = () => {}) {
      journal.close(); ledger.close();
      beforeOpen();
      journal = new PullJournal(journalPath, HUB, endpoint);
      ledger = new AttemptLedger(ledgerPath, global);
      return runner();
    },
  };
}

describe('durable outbound-pull state machine', () => {
  it('commits reference/cursor before fresh authorization and budgets before callback I/O', async () => {
    const f = await setup();
    f.control.authorize.mockImplementation(async () => {
      expect(f.journal.read()).toEqual({ after: f.after, pending: { ref: f.ref, result: null } });
      return f.job;
    });
    f.deliver.mockImplementation(async () => {
      expect(f.ledger.reserve(f.job, Date.now())).toMatchObject({ kind: 'duplicate', result: INDETERMINATE });
      return verified;
    });
    expect(await f.runner().step(signal())).toBe('reported');
    expect(f.control.complete).toHaveBeenCalledWith(f.ref, verified, expect.any(AbortSignal));
    expect(f.journal.read()).toEqual({ after: f.after, pending: null });
    expect(f.ledger.recordedResult(f.job.jobId)).toEqual(verified);
  });

  it('does not send a cancelled reference or report a fabricated success', async () => {
    const f = await setup();
    f.control.authorize.mockResolvedValue(null);
    expect(await f.runner().step(signal())).toBe('cancelled');
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.control.complete).not.toHaveBeenCalled();
    expect(f.ledger.recordedResult(f.ref.jobId)).toBeNull();
    expect(f.journal.read().pending).toBeNull();
  });

  it.each(['before-reserve', 'reserved', 'completed'])('recovers %s after restart without authorizing or sending', async phase => {
    const f = await setup();
    f.journal.accept({ ref: f.ref, after: f.after });
    if (phase !== 'before-reserve') f.ledger.reserve(f.job, Date.now());
    if (phase === 'completed') f.ledger.complete(f.ref.jobId, verified);
    await f.restart().step(signal());
    expect(f.control.poll).not.toHaveBeenCalled();
    expect(f.control.authorize).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.control.complete).toHaveBeenCalledWith(f.ref, phase === 'completed' ? verified : INDETERMINATE, expect.any(AbortSignal));
  });

  it('replays a lost result acknowledgment unchanged across restarts and blocks new claims meanwhile', async () => {
    const f = await setup();
    f.control.complete.mockRejectedValue(new Error('lost acknowledgment'));
    await expect(f.runner().step(signal())).rejects.toThrow();
    expect(f.journal.read().pending).toEqual({ ref: f.ref, result: verified });
    await expect(f.restart().step(signal())).rejects.toThrow();
    f.control.complete.mockResolvedValue(undefined);
    await f.restart().step(signal());
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.control.authorize).toHaveBeenCalledTimes(1);
    expect(f.control.poll).toHaveBeenCalledTimes(1);
    for (const [ref, result] of f.control.complete.mock.calls) expect({ ref, result }).toEqual({ ref: f.ref, result: verified });
    expect(f.journal.read().pending).toBeNull();
  });

  it('losing an authorization response becomes indeterminate, not a later callback', async () => {
    const f = await setup();
    f.control.authorize.mockRejectedValue(new Error('lost response'));
    await expect(f.runner().step(signal())).rejects.toThrow();
    await f.restart().step(signal());
    expect(f.control.authorize).toHaveBeenCalledTimes(1);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.control.complete).toHaveBeenCalledWith(f.ref, INDETERMINATE, expect.any(AbortSignal));
  });

  it('does not move continuation or invent a job after a lost poll response', async () => {
    const f = await setup();
    f.control.poll.mockRejectedValue(new Error('lost poll'));
    await expect(f.runner().step(signal())).rejects.toThrow();
    expect(f.journal.read()).toEqual({ after: null, pending: null });
    expect(f.control.authorize).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('suppresses duplicate callbacks even if the hub repeats an already acknowledged reference', async () => {
    const f = await setup();
    await f.runner().step(signal());
    await f.restart().step(signal());
    expect(f.control.authorize).toHaveBeenCalledTimes(2);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.control.complete).toHaveBeenCalledTimes(2);
  });

  it.each(['limit', 'conflict', 'uncertain'])('fails closed for ledger %s without a callback retry', async mode => {
    const f = await setup(1);
    if (mode === 'limit') f.ledger.reserve(await makeJob(), Date.now());
    if (mode === 'conflict') f.ledger.reserve({ ...f.job, secret: 'different'.repeat(8) }, Date.now());
    if (mode === 'uncertain') f.ledger.reserve(f.job, Date.now());
    await f.runner().step(signal());
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.control.complete).toHaveBeenCalledWith(f.ref, INDETERMINATE, expect.any(AbortSignal));
  });

  it('treats thrown or malformed callback results as uncertain without leaking details', async () => {
    for (const output of [new Error('private network error'), { ...verified, secret: 'never persist this' }]) {
      const f = await setup();
      if (output instanceof Error) f.deliver.mockRejectedValue(output); else f.deliver.mockResolvedValue(output);
      await f.runner().step(signal());
      expect(f.ledger.recordedResult(f.ref.jobId)).toEqual(INDETERMINATE);
      expect(f.control.complete).toHaveBeenCalledWith(f.ref, INDETERMINATE, expect.any(AbortSignal));
    }
  });

  it('does no network work when journal storage is unavailable', async () => {
    const f = await setup();
    vi.spyOn(f.journal, 'read').mockImplementation(() => { throw new Error('storage failed'); });
    await expect(f.runner().step(signal())).rejects.toThrow();
    expect(f.control.poll).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('retains only references, cursor and outcomes, and binds the journal to one operator configuration', async () => {
    const f = await setup();
    f.control.complete.mockRejectedValue(new Error());
    await expect(f.runner().step(signal())).rejects.toThrow();
    for (const file of readdirSync(f.dir)) {
      const bytes = readFileSync(join(f.dir, file));
      expect(bytes.includes(Buffer.from(f.job.secret))).toBe(false);
      expect(bytes.includes(Buffer.from(f.job.url))).toBe(false);
      expect(bytes.includes(Buffer.from(f.job.body.nonce!))).toBe(false);
    }
    expect(() => new PullJournal(f.journalPath, HUB, endpoint)).toThrow(); // exclusive process lock
    f.restart(() => {
      expect(() => new PullJournal(f.journalPath, 'https://other.example.net', endpoint)).toThrow();
      expect(() => new PullJournal(f.journalPath, HUB, 'https://other.example.net/internal/wake-control')).toThrow();
    });
  });

  it('persists empty-page continuation across restart and wraps only when instructed', async () => {
    const f = await setup();
    f.control.poll.mockResolvedValueOnce({ ref: null, after: f.after }).mockResolvedValue({ ref: null, after: null });
    expect(await f.runner().step(signal())).toBe('idle');
    expect(await f.restart().step(signal())).toBe('idle');
    expect(f.control.poll.mock.calls.map(([after]) => after)).toEqual([null, f.after]);
    expect(f.journal.read().after).toBeNull();
    expect(f.control.authorize).not.toHaveBeenCalled();
  });

  it('rejects overlapping local steps and stops before send when authorization is interrupted', async () => {
    const f = await setup();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.control.authorize.mockImplementation(async () => { await blocked; return f.job; });
    const controller = new AbortController();
    const runner = f.runner();
    const first = runner.step(controller.signal);
    await expect(runner.step(signal())).rejects.toThrow('already running');
    controller.abort(); release();
    await expect(first).rejects.toThrow();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.journal.read().pending?.result).toBeNull();
  });

  it('allows an in-flight bounded callback to finish on shutdown and reports its outcome only on recovery', async () => {
    const f = await setup();
    const controller = new AbortController();
    f.deliver.mockImplementation(async () => { controller.abort(); return verified; });
    await expect(f.runner().step(controller.signal)).rejects.toThrow();
    expect(f.journal.read().pending?.result).toEqual(verified);
    expect(f.control.complete).not.toHaveBeenCalled();
    await f.restart().step(signal());
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.control.complete).toHaveBeenCalledWith(f.ref, verified, expect.any(AbortSignal));
  });
});

describe('bounded polling cadence', () => {
  it('waits one second between healthy starts; abort wakes the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stop = new AbortController();
    const runner = { step: vi.fn().mockResolvedValue('idle') };
    const loop = runPullLoop(runner, stop.signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(runner.step).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.step).toHaveBeenCalledTimes(2);
    stop.abort(); await loop;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off boundedly on outages, resets on success, and never overlaps cycles', async () => {
    expect([1, 2, 3, 4, 5, 6, 99].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stop = new AbortController();
    const runner = { step: vi.fn().mockRejectedValueOnce(new Error()).mockRejectedValueOnce(new Error()).mockResolvedValue('idle') };
    const loop = runPullLoop(runner, stop.signal);
    await vi.advanceTimersByTimeAsync(2999);
    expect(runner.step).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.step).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runner.step).toHaveBeenCalledTimes(4);
    stop.abort(); await loop;
  });
});
