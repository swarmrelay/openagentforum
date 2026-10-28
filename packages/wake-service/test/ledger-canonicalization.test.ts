import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@openagentforum/protocol';
import { AttemptLedger } from '../src/ledger.js';
import { makeJob } from './fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #382: the attempt ledger digests a job with `canonicalizeJson(job)`.
 * `canonicalizeJson` changed in @openagentforum/protocol 2.3.0: a property
 * whose value is `undefined` is now dropped (mirroring JSON.stringify)
 * instead of being emitted as the literal text `undefined`, and `toJSON`
 * is applied. A `DeliveryJob` built in memory with an optional `undefined`
 * field therefore digests differently before and after the operator
 * upgrades the separately installed sender, so a reservation retried
 * across that upgrade would not match its own earlier digest.
 *
 * The contract we pin here: the digest must not depend on in-memory
 * `undefined` optional fields, whatever canonicalization behaviour is
 * installed. Both shapes must digest identically, so the fix (normalising
 * the job through a JSON round trip, or through an explicit field list)
 * keeps the digest stable across protocol upgrades.
 */
describe('attempt ledger digest is stable across canonicalization behaviour (#382)', () => {
  const digest = (job: unknown): string =>
    createHash('sha256').update(canonicalizeJson(job)).digest('hex');

  it('ignores optional undefined fields when digesting a job', async () => {
    const job = await makeJob();
    // A wake body with every optional field explicitly present and set.
    const full = {
      kind: 'wake',
      hub: job.body.hub,
      hookId: job.body.hookId,
      agentId: job.body.agentId,
      sentAt: job.body.sentAt,
      channel: 'general',
      storedSeq: 1,
      envelopeId: 'urn:uuid:9f2110e3-3b59-4573-b884-f5c4f4751237',
      sender: job.body.agentId,
      type: 'intel',
      mentioned: true,
    };
    // The same body with the optional fields undefined (in-memory shape).
    const sparse = {
      kind: 'wake',
      hub: job.body.hub,
      hookId: job.body.hookId,
      agentId: job.body.agentId,
      sentAt: job.body.sentAt,
      channel: undefined,
      storedSeq: undefined,
      envelopeId: undefined,
      sender: undefined,
      type: undefined,
      mentioned: undefined,
    };
    // A job whose optional fields are undefined must digest identically to
    // the same job with those fields absent (the shape a JSON round trip,
    // or an older/newer canonicalizeJson, produces).
    const jsonRoundTrip = JSON.parse(JSON.stringify(sparse)) as Record<string, unknown>;
    expect(digest(sparse)).toBe(digest(jsonRoundTrip));
    // ... and identically to a hand-built minimal body without them.
    const minimal = {
      kind: 'wake',
      hub: job.body.hub,
      hookId: job.body.hookId,
      agentId: job.body.agentId,
      sentAt: job.body.sentAt,
    };
    expect(digest(sparse)).toBe(digest(minimal));
    // The full body still differs from the sparse one (fields carry data),
    // which is what makes the digest meaningful.
    expect(digest(full)).not.toBe(digest(sparse));
  });

  it('accepts a reservation retried with the same job after a JSON round trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oaf-wake-382-'));
    try {
      const path = join(dir, 'attempts.sqlite');
      const first = new AttemptLedger(path);
      const job = await makeJob();
      expect(first.reserve(job, Date.now())).toEqual({ kind: 'reserved' });
      first.close();

      // Simulate the post-upgrade sender: the same logical job arrives
      // through a parse/serialize boundary, so optional fields that were
      // undefined are now absent (or vice versa).
      const second = new AttemptLedger(path);
      const reparsed = JSON.parse(JSON.stringify(job)) as typeof job;
      const reservation = second.reserve(reparsed, Date.now());
      expect(reservation.kind).toBe('duplicate');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
