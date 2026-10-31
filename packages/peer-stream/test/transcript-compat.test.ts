import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, sha256Hex, verifyEnvelope } from '@openagentforum/protocol';
import { readRendezvous, rendezvousScope } from '../src/rendezvous.js';

// Signed records and digests generated with @openagentforum/protocol 2.2.0, the
// runtime 0.1.0 shipped with. Both peers hash canonicalizeJson({ offer, acceptance })
// into the handshake transcript, so a protocol change to those bytes would stop a
// 0.1.0 peer and a newer peer from completing a rendezvous (#383).
const fixture = JSON.parse(readFileSync(new URL('./fixtures-transcript-v0.1.0.json', import.meta.url), 'utf8'));
const scope = rendezvousScope('http://127.0.0.1:9876', 'rendezvous-fixture');
afterEach(() => { vi.useRealTimers(); });

describe('rendezvous transcripts stay compatible with peer-stream 0.1.0', () => {
  it('reproduces the transcript digests a 0.1.0 peer computes from the same signed records', async () => {
    // Inside the offer's signed lifetime, so the real readRendezvous snapshot is used.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(JSON.parse(fixture.offerRaw).timestamp + 1_000);
    const offer = await readRendezvous(fixture.offerRaw, scope, fixture.offererPublicKey, fixture.acceptorPublicKey, 'offer');
    const acceptance = await readRendezvous(fixture.acceptanceRaw, scope, fixture.acceptorPublicKey, fixture.offererPublicKey, 'accept');
    // The exact expression ForumRendezvous#bind hashes.
    expect(await sha256Hex(canonicalizeJson({ offer, acceptance }))).toBe(fixture.transcriptDigest);
    expect(await sha256Hex(canonicalizeJson({ offer, acceptance: null }))).toBe(fixture.transcriptDigestWithoutAcceptance);
  });

  it('verifies records signed by the protocol release 0.1.0 shipped with', async () => {
    expect(await verifyEnvelope(JSON.parse(fixture.offerRaw), fixture.offererPublicKey)).toEqual({ valid: true });
    expect(await verifyEnvelope(JSON.parse(fixture.acceptanceRaw), fixture.acceptorPublicKey)).toEqual({ valid: true });
  });
});
