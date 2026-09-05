import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptLedger } from '../src/ledger.js';
import { makeJob } from './fixtures.js';

const dirs: string[] = [];
const ledgers: AttemptLedger[] = [];
function setup(global = 1000, capacity = 50_000) {
  const dir = mkdtempSync(join(tmpdir(), 'oaf-wake-test-'));
  dirs.push(dir);
  const path = join(dir, 'attempts.sqlite');
  const ledger = new AttemptLedger(path, global, capacity);
  ledgers.push(ledger);
  return { dir, path, ledger };
}
afterEach(() => {
  for (const ledger of ledgers.splice(0)) { try { ledger.close(); } catch { /* already closed for restart */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable attempt ledger', () => {
  it('suppresses concurrent/restarted uncertain sends, including reordered JSON', async () => {
    const { ledger, path } = setup();
    const job = await makeJob();
    expect(ledger.reserve(job, Date.now())).toEqual({ kind: 'reserved' });
    const second = new AttemptLedger(path);
    ledgers.push(second);
    const reordered = { body: job.body, secret: job.secret, url: job.url, jobId: job.jobId };
    expect(second.reserve(reordered, Date.now())).toMatchObject({ kind: 'duplicate', result: { code: 'indeterminate', retryable: false } });
    ledger.close();
    expect(second.reserve(job, Date.now())).toMatchObject({ kind: 'duplicate', result: { code: 'indeterminate' } });
  });

  it('remembers completed results and refuses reuse of a job ID with new content', async () => {
    const { ledger } = setup();
    const job = await makeJob();
    ledger.reserve(job, Date.now());
    const result = { ok: true, code: 'verified' as const, retryable: false, status: 200 };
    ledger.complete(job.jobId, result);
    expect(ledger.reserve(job, Date.now())).toEqual({ kind: 'duplicate', result });
    expect(ledger.reserve({ ...job, secret: 'changed'.repeat(8) }, Date.now())).toEqual({ kind: 'conflict' });
    // A late completion cannot overwrite the first outcome.
    ledger.complete(job.jobId, { ok: false, code: 'network_error', retryable: true });
    expect(ledger.reserve(job, Date.now())).toEqual({ kind: 'duplicate', result });
  });

  it('enforces a hard 600-attempt per-hook budget across independent connections', async () => {
    const { ledger, path } = setup();
    const other = new AttemptLedger(path);
    ledgers.push(other);
    const now = 10 * 3600_000;
    const job = await makeJob();
    for (let n = 0; n < 600; n++) expect((n % 2 ? other : ledger).reserve({ ...job, jobId: randomUUID() }, now)).toEqual({ kind: 'reserved' });
    expect(other.reserve({ ...job, jobId: randomUUID() }, now)).toEqual({ kind: 'limited', retryAfter: 3600 });
    expect(other.reserve({ ...job, jobId: randomUUID() }, now + 3600_000)).toEqual({ kind: 'reserved' });
  });

  it('enforces the global cap, persists it across restart, and does not reset on a clock rollback', async () => {
    const { ledger, path } = setup(1);
    const job = await makeJob();
    const now = 10 * 3600_000;
    ledger.reserve(job, now);
    ledger.close();
    const restarted = new AttemptLedger(path, 1);
    ledgers.push(restarted);
    expect(restarted.reserve(await makeJob({ url: 'https://another.example/wake' }), now)).toMatchObject({ kind: 'limited' });
    expect(restarted.reserve(await makeJob(), now - 3600_000)).toMatchObject({ kind: 'limited' });
    // Duplicate requests consume no additional budget.
    expect(restarted.reserve(job, now)).toMatchObject({ kind: 'duplicate' });
  });

  it('bounds retained rows and prunes after 24 hours without storing URLs or secrets', async () => {
    const { dir, ledger } = setup(1000, 1);
    const job = await makeJob();
    const now = Date.now();
    ledger.reserve(job, now);
    expect(ledger.reserve(await makeJob(), now)).toMatchObject({ kind: 'limited' });
    for (const file of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, file));
      expect(bytes.includes(Buffer.from(job.secret))).toBe(false);
      expect(bytes.includes(Buffer.from(job.url))).toBe(false);
    }
    expect(ledger.reserve(await makeJob(), now + 24 * 3600_000)).toMatchObject({ kind: 'reserved' });
  });
});
