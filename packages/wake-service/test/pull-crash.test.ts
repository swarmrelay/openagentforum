import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AttemptLedger } from '../src/ledger.js';
import { PullJournal } from '../src/pull-journal.js';
import { createPullRunner } from '../src/pull-runner.js';
import { INDETERMINATE } from '../src/pull-protocol.js';
import { HUB, makeJob } from './fixtures.js';

const endpoint = 'https://control.example.net/internal/wake-control';
const journalModule = new URL('../dist/pull-journal.js', import.meta.url).href;
const ledgerModule = new URL('../dist/ledger.js', import.meta.url).href;
const verified = { ok: true, code: 'verified' as const, retryable: false, status: 200 };

it.each(['reference', 'reservation', 'outcome', 'report'])('recovers committed %s after SIGKILL and releases the exclusive process lock', async phase => {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-pull-crash-'));
  const job = await makeJob();
  const ref = { agentId: job.body.agentId, jobId: job.jobId, kind: job.body.kind };
  const after = { dueAt: Date.now(), agentId: ref.agentId };
  const journalPath = join(dir, 'pull.sqlite');
  const ledgerPath = join(dir, 'attempts.sqlite');
  // Child does no network I/O. Values go over stdin, not process arguments/logs.
  const script = `
    import { readFileSync } from 'node:fs';
    import { PullJournal } from ${JSON.stringify(journalModule)};
    import { AttemptLedger } from ${JSON.stringify(ledgerModule)};
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.umask(0o077);
    const journal = new PullJournal(input.journalPath, input.hub, input.endpoint);
    const ledger = new AttemptLedger(input.ledgerPath);
    journal.accept({ ref: input.ref, after: input.after });
    if (input.phase !== 'reference') ledger.reserve(input.job, Date.now());
    if (['outcome', 'report'].includes(input.phase)) ledger.complete(input.job.jobId, input.result);
    if (input.phase === 'report') journal.result(input.ref, input.result);
    process.stdout.write('committed\\n');
    // Keep both native connections reachable while this crash fixture is idle.
    setInterval(() => { journal.read(); ledger.recordedResult(input.job.jobId); }, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  let journal: PullJournal | undefined;
  let ledger: AttemptLedger | undefined;
  try {
    child.stdin.end(JSON.stringify({ journalPath, ledgerPath, hub: HUB, endpoint, job, ref, after, phase, result: verified }));
    await Promise.race([
      once(child.stdout, 'data').then(([data]) => expect(String(data)).toBe('committed\n')),
      exit.then(() => { throw new Error('child exited before committing fixture'); }),
    ]);
    let contender: PullJournal | undefined;
    try { expect(() => { contender = new PullJournal(journalPath, HUB, endpoint); }).toThrow(); }
    finally { contender?.close(); }
    child.kill('SIGKILL');
    expect((await exit)[1]).toBe('SIGKILL');
    journal = new PullJournal(journalPath, HUB, endpoint);
    ledger = new AttemptLedger(ledgerPath);
    expect(journal.read().after).toEqual(after);
    const control = { poll: vi.fn(), authorize: vi.fn(), complete: vi.fn().mockResolvedValue(undefined) };
    const deliver = vi.fn();
    await createPullRunner({ journal, ledger, control, deliver }).step(new AbortController().signal);
    expect(control.poll).not.toHaveBeenCalled();
    expect(control.authorize).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(control.complete).toHaveBeenCalledWith(ref, ['outcome', 'report'].includes(phase) ? verified : INDETERMINATE, expect.any(AbortSignal));
    expect(journal.read().pending).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
    journal?.close(); ledger?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
