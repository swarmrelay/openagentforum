/**
 * Coverage for the poll input validators and the leaf recipe (#34 / #238).
 *
 * `polls.test.ts` exercises the tally and ingest paths through signed envelopes
 * but never calls the two payload validators, `isPollCandidate`, `normalizeHub`
 * or `pollLeafBytes` directly. The validators are the boundary that keeps a
 * malformed vote out of the tally at all, and `pollLeafBytes` is the recipe the
 * Merkle proof is built on — if its field order or separators drift, every
 * previously issued proof stops verifying while the code still "works".
 */
import { describe, expect, it } from 'vitest';
import {
  POLL_LIMITS,
  isPollCandidate,
  normalizeHub,
  pollLeafBytes,
  validateClosePayload,
  validateVotePayload,
  validatePollOpen,
} from '../src/index.js';

const POLL_HASH = 'a'.repeat(64);

function envelope(over: Record<string, unknown> = {}) {
  return {
    id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    channel: 'general',
    sender: 'agent_x',
    type: 'vote',
    sequence: 1,
    checksum: 'b'.repeat(64),
    signature: 'c'.repeat(128),
    storedSeq: 7,
    ...over,
  } as any;
}

describe('validateVotePayload: the boundary that keeps a malformed vote out of the tally', () => {
  const good = { pollId: 'poll_1', pollHash: POLL_HASH, choice: 0 };

  it('accepts a well-formed vote', () => {
    const out = validateVotePayload(good);
    expect(out.ok).toBe(true);
  });

  it('accepts a vote carrying a justificationRef', () => {
    const out = validateVotePayload({ ...good, justificationRef: 'urn:uuid:abc' });
    expect(out.ok).toBe(true);
  });

  it.each([
    [null, 'payload required'],
    ['string', 'payload required'],
    [{}, 'pollId required'],
    [{ pollId: '', pollHash: POLL_HASH, choice: 0 }, 'pollId required'],
    [{ pollId: 'p', pollHash: 'short', choice: 0 }, 'pollHash must be a sha256 hex'],
    [{ pollId: 'p', pollHash: POLL_HASH, choice: -1 }, 'choice must be a non-negative integer index'],
    [{ pollId: 'p', pollHash: POLL_HASH, choice: 1.5 }, 'choice must be a non-negative integer index'],
    [{ pollId: 'p', pollHash: POLL_HASH, choice: '0' }, 'choice must be a non-negative integer index'],
    [{ pollId: 'p', pollHash: POLL_HASH, choice: 0, justificationRef: 'x'.repeat(201) }, 'justificationRef must be an envelope id'],
  ])('rejects %p with %s', (input, message) => {
    const out = validateVotePayload(input);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toBe(message);
  });

  it('accepts an uppercase sha256 pollHash, because the pattern is case-insensitive', () => {
    // Pinned deliberately: the regex is /i, so a client that uppercases the hash
    // is not rejected here. If that ever tightens, this test is the diff.
    expect(validateVotePayload({ pollId: 'p', pollHash: 'A'.repeat(64), choice: 0 }).ok).toBe(true);
  });
});

describe('validateClosePayload: only a close-kind payload is accepted', () => {
  it('accepts kind=close with pollId and pollHash', () => {
    expect(validateClosePayload({ kind: 'close', pollId: 'p', pollHash: POLL_HASH }).ok).toBe(true);
  });

  it.each([
    [null],
    ['close'],
    [{}],
    [{ kind: 'open', pollId: 'p', pollHash: POLL_HASH }],
    [{ kind: 'close', pollId: 'p' }],
    [{ kind: 'close', pollHash: POLL_HASH }],
  ])('rejects %p', (input) => {
    const out = validateClosePayload(input);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toBe('close needs kind, pollId, pollHash');
  });
});

describe('isPollCandidate: which envelopes the poll sweep even looks at', () => {
  it('selects poll and vote envelopes', () => {
    expect(isPollCandidate(envelope({ type: 'poll' }))).toBe(true);
    expect(isPollCandidate(envelope({ type: 'vote' }))).toBe(true);
  });

  it.each(['intel', 'task', 'hook', ''])('skips a %s envelope', (type) => {
    expect(isPollCandidate(envelope({ type }))).toBe(false);
  });
});

describe('normalizeHub: one form per hub URL', () => {
  it('trims, lowercases and strips trailing slashes', () => {
    expect(normalizeHub('  HTTPS://Hub.Test/  ')).toBe('https://hub.test');
    expect(normalizeHub('https://hub.test///')).toBe('https://hub.test');
    expect(normalizeHub('https://hub.test')).toBe('https://hub.test');
  });

  it('keeps a path, since a hub may be hosted under one', () => {
    expect(normalizeHub('https://hub.test/oaf/')).toBe('https://hub.test/oaf');
  });

  it('does not touch the scheme-relative middle of the URL', () => {
    expect(normalizeHub('https://hub.test/A/B')).toBe('https://hub.test/a/b');
  });
});

describe('pollLeafBytes: the recipe every issued proof depends on', () => {
  it('is deterministic and starts with the versioned prefix', () => {
    const a = pollLeafBytes(POLL_HASH, envelope());
    const b = pollLeafBytes(POLL_HASH, envelope());
    expect(a).toBe(b);
    expect(a.startsWith('oaf-poll-leaf-v1|')).toBe(true);
  });

  it('lays out the fields in the documented order', () => {
    const leaf = pollLeafBytes(POLL_HASH, envelope());
    expect(leaf.split('|')).toEqual([
      'oaf-poll-leaf-v1', POLL_HASH, '7',
      'urn:uuid:00000000-0000-4000-8000-000000000001',
      'agent_x', '1', 'b'.repeat(64), 'c'.repeat(128),
    ]);
  });

  it('falls back to 0 for an envelope that never got a storedSeq', () => {
    const leaf = pollLeafBytes(POLL_HASH, envelope({ storedSeq: undefined }));
    expect(leaf.split('|')[2]).toBe('0');
  });

  it('changes when any single field changes', () => {
    const base = pollLeafBytes(POLL_HASH, envelope());
    const variants = [
      pollLeafBytes('d'.repeat(64), envelope()),
      pollLeafBytes(POLL_HASH, envelope({ storedSeq: 8 })),
      pollLeafBytes(POLL_HASH, envelope({ id: 'urn:uuid:other' })),
      pollLeafBytes(POLL_HASH, envelope({ sender: 'agent_y' })),
      pollLeafBytes(POLL_HASH, envelope({ sequence: 2 })),
      pollLeafBytes(POLL_HASH, envelope({ checksum: 'e'.repeat(64) })),
      pollLeafBytes(POLL_HASH, envelope({ signature: 'f'.repeat(128) })),
    ];
    for (const v of variants) expect(v).not.toBe(base);
  });
});

describe('POLL_LIMITS: the published caps the validators read', () => {
  it('keeps optionsMin below optionsMax and both inside the list range', () => {
    expect(POLL_LIMITS.optionsMin).toBeLessThan(POLL_LIMITS.optionsMax);
    expect(POLL_LIMITS.listMin).toBeLessThanOrEqual(POLL_LIMITS.optionsMin);
    expect(POLL_LIMITS.listMax).toBeGreaterThanOrEqual(POLL_LIMITS.optionsMax);
  });

  it('rejects a poll with more options than the cap allows', async () => {
    const tooMany = Array.from({ length: POLL_LIMITS.optionsMax + 1 }, (_, i) => `option ${i}`);
    const out = validatePollOpen({ title: 't', description: 'd', options: tooMany, durationHours: 24 });
    expect(out.ok).toBe(false);
  });
});
