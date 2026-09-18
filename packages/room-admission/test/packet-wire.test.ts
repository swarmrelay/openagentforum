import { createHash, createPublicKey, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, generateAgentKeyPair } from '@openagentforum/protocol';
import {
  ROOM_PACKET_LIMITS, ROOM_PACKET_PROFILE, ROOM_PACKET_PROTOCOL,
  ROOM_PACKET_READ_PROTOCOL, ROOM_PACKET_RECOVERY_PROTOCOL,
  prepareRoomPacket, prepareRoomPacketRead, prepareRoomPacketRecovery,
  signRoomPacket, signRoomPacketRead, signRoomPacketRecovery, verifyHistoricalRoomPacketSignature,
  type RoomPacketWrite, type RoomPacketRead, type RoomPacketRecovery,
} from '../src/packet-wire.js';
import { ROOM_NOISE_PROFILE } from '../src/key-bindings.js';
import { createRoomNoiseSession, ROOM_NOISE_LIMITS, type RoomNoiseSession } from '../src/handshake.js';
import { prepareRoomControl, ROOM_CONTROL_PROTOCOL } from '../src/control.js';
import { prepareRoomStateRead, ROOM_STATE_PROTOCOL } from '../src/state-read.js';
import { prepareRoomRecovery, ROOM_RECOVERY_PROTOCOL } from '../src/recovery.js';
import { actionFor, admitted, fixture as admissionFixture } from './fixtures.js';

const HUB = 'https://relay.example.com';
const NOW = 1_800_000_000_000;
const context = { hub: HUB, now: NOW };
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const key = await generateAgentKeyPair();
  const common = { hub: HUB, roomId: `room_${'1'.repeat(32)}`, actor: key.agentId,
    signingPublicKey: key.signingPublicKey, issuedAt: NOW, expiresAt: NOW + 60_000 };
  const write: RoomPacketWrite = { ...common, protocol: ROOM_PACKET_PROTOCOL, requestId: '2'.repeat(32),
    expectedRevision: 3, profile: ROOM_PACKET_PROFILE, sessionId: '3'.repeat(32),
    packetIndex: 2, kind: 'data', packetHex: 'ab'.repeat(17) };
  const read: RoomPacketRead = { ...common, protocol: ROOM_PACKET_READ_PROTOCOL, queryId: '4'.repeat(32),
    expectedRevision: 3, afterStoredSeq: 0, limit: 8 };
  const recover: RoomPacketRecovery = { ...common, protocol: ROOM_PACKET_RECOVERY_PROTOCOL,
    queryId: '5'.repeat(32), requestId: write.requestId, proofDigest: '6'.repeat(64) };
  return { key, write, read, recover };
}
type Operation = 'write' | 'read' | 'recover';
async function operation(kind: Operation) {
  const f = await fixture();
  const request = f[kind];
  const wire = kind === 'write' ? await signRoomPacket(f.write, f.key.signingPrivateKey)
    : kind === 'read' ? await signRoomPacketRead(f.read, f.key.signingPrivateKey)
      : await signRoomPacketRecovery(f.recover, f.key.signingPrivateKey);
  const prepare = kind === 'write' ? prepareRoomPacket : kind === 'read' ? prepareRoomPacketRead : prepareRoomPacketRecovery;
  return { ...f, request, wire, prepare };
}

describe.each(['write', 'read', 'recover'] as const)('%s packet proof (not membership)', kind => {
  it('uses independent PureEd25519 verification, domain-bound digest and frozen prepared fields', async () => {
    const s = await operation(kind);
    const bytes = Buffer.from(`${s.request.protocol}\n${canonicalizeJson(s.request)}`);
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(s.key.signingPublicKey, 'hex')]), format: 'der', type: 'spki' });
    expect(verify(null, bytes, publicKey, Buffer.from(JSON.parse(s.wire).signature, 'hex'))).toBe(true);
    const p = await s.prepare(s.wire, context);
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error('Fixture verification failed');
    expect(p.request).toEqual(s.request);
    expect(p.proofDigest).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(Object.isFrozen(p) && Object.isFrozen(p.request)).toBe(true);
    expect(() => Object.assign(p.request, { expiresAt: Number.MAX_SAFE_INTEGER })).toThrow();
    expect(p.freshness(s.request.expiresAt)).toBe('expired_proof');
    expect(p.freshness(s.request.expiresAt - 1)).toBeNull();
  });

  it('binds every signed field, including complete key, operation and ciphertext/cursor', async () => {
    const s = await operation(kind);
    const other = await generateAgentKeyPair();
    const substitutions: Record<string, unknown> = {
      protocol: ROOM_STATE_PROTOCOL, hub: 'https://other.example.com', roomId: `room_${'a'.repeat(32)}`,
      actor: other.agentId, signingPublicKey: other.signingPublicKey, issuedAt: NOW + 1, expiresAt: NOW + 59_999,
      requestId: 'a'.repeat(32), expectedRevision: 4, profile: 'other-profile', sessionId: 'b'.repeat(32),
      packetIndex: 3, kind: 'handshake', packetHex: 'cd'.repeat(17), queryId: 'b'.repeat(32),
      afterStoredSeq: 1, limit: 7, proofDigest: 'a'.repeat(64), signature: '0'.repeat(128),
    };
    const proof = JSON.parse(s.wire);
    for (const field of Object.keys(proof)) {
      expect(Object.hasOwn(substitutions, field)).toBe(true);
      expect((await s.prepare(canonicalizeJson({ ...proof, [field]: substitutions[field] }), context)).ok, field).toBe(false);
    }
    // Replacing both the full key and its matching short ID still cannot keep the original signature.
    expect(await s.prepare(canonicalizeJson({ ...proof, actor: other.agentId, signingPublicKey: other.signingPublicKey }), context))
      .toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects malformed, aliased, prototype-bearing and oversized wire before signature verification', async () => {
    const s = await operation(kind); const p = JSON.parse(s.wire);
    const max = kind === 'write' ? ROOM_PACKET_LIMITS.wireBytes : ROOM_PACKET_LIMITS.queryBytes;
    const variants = [
      '', '{', 'null', '[]', s.wire + ' ', JSON.stringify(p, Object.keys(p).reverse()),
      s.wire.replace('{', `{"actor":"${p.actor}",`), s.wire.replace('agent_', '\\u0061gent_'),
      s.wire.replace(String(NOW), '18e11'), s.wire.replace(String(NOW), '-0'),
      canonicalizeJson({ ...p, roomId: undefined }), canonicalizeJson({ ...p, roomId: { value: p.roomId } }),
      canonicalizeJson({ ...p, permission: true }), canonicalizeJson({ ...p, constructor: 'unexpected' }),
      canonicalizeJson({ ...p, prototype: 'unexpected' }), s.wire.replace('{', '{"__proto__":{},'),
      canonicalizeJson({ ...p, signingPublicKey: p.actor }),
      'x'.repeat(max + 1), 'é'.repeat(Math.ceil(max / 2) + 1),
    ];
    const spy = vi.spyOn(crypto.subtle, 'verify');
    for (const wire of variants) expect((await s.prepare(wire, context)).ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('requires exact configured HTTPS origin and fresh bounded proofs', async () => {
    const s = await operation(kind);
    for (const hub of ['http://relay.example.com', HUB + '/', HUB + '/path', 'https://user@relay.example.com',
      'https://relay.example.com:443', 'https://RELAY.example.com', 'invalid']) {
      expect(await s.prepare(s.wire, { ...context, hub })).toEqual({ ok: false, reason: 'invalid_context' });
    }
    expect(await s.prepare(s.wire, { hub: 'https://different.example.com', now: NOW })).toEqual({ ok: false, reason: 'wrong_hub' });
    for (const now of [-1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await s.prepare(s.wire, { hub: HUB, now })).toEqual({ ok: false, reason: 'invalid_context' });
    }
    expect((await s.prepare(s.wire, { hub: HUB, now: NOW - 30_000 })).ok).toBe(true);
    expect(await s.prepare(s.wire, { hub: HUB, now: NOW - 30_001 })).toEqual({ ok: false, reason: 'future_proof' });
    expect(await s.prepare(s.wire, { hub: HUB, now: NOW + 60_000 })).toEqual({ ok: false, reason: 'expired_proof' });
    for (const expiresAt of [NOW, NOW - 1, NOW + 60_001, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await s.prepare(canonicalizeJson({ ...JSON.parse(s.wire), expiresAt }), context))
        .toEqual({ ok: false, reason: 'invalid_schema' });
    }
  });

  it('is not reusable across packet operations, control, state or control-receipt recovery', async () => {
    const s = await operation(kind);
    for (const prepare of [prepareRoomPacket, prepareRoomPacketRead, prepareRoomPacketRecovery]) {
      if (prepare !== s.prepare) expect(await prepare(s.wire, context)).toEqual({ ok: false, reason: 'invalid_schema' });
    }
    for (const prepare of [prepareRoomControl, prepareRoomStateRead, prepareRoomRecovery]) {
      expect((await prepare(s.wire, s.key.signingPublicKey, context)).ok).toBe(false);
    }
    for (const protocol of [ROOM_CONTROL_PROTOCOL, ROOM_STATE_PROTOCOL, ROOM_RECOVERY_PROTOCOL]) {
      expect((await s.prepare(canonicalizeJson({ ...JSON.parse(s.wire), protocol }), context)).ok).toBe(false);
    }
  });
});

describe('packet wire bounds and helper boundaries', () => {
  it('snapshots all three local signing inputs and verification context before awaiting', async () => {
    const f = await fixture();
    const original = [f.write, f.read, f.recover].map(request => ({ ...request }));
    const pending = [signRoomPacket(f.write, f.key.signingPrivateKey), signRoomPacketRead(f.read, f.key.signingPrivateKey),
      signRoomPacketRecovery(f.recover, f.key.signingPrivateKey)];
    for (const request of [f.write, f.read, f.recover]) request.roomId = `room_${'f'.repeat(32)}`;
    const wires = await Promise.all(pending);
    const prepares = [prepareRoomPacket, prepareRoomPacketRead, prepareRoomPacketRecovery];
    for (let i = 0; i < wires.length; i++) {
      const ctx = { ...context }; const p = prepares[i](wires[i], ctx);
      ctx.hub = 'https://other.example.com'; ctx.now = NOW + 60_000;
      expect(await p).toMatchObject({ ok: true, request: original[i] });
    }
  });

  it('rejects invalid local requests instead of signing repaired schemas or accepting a preexisting signature', async () => {
    const f = await fixture();
    await expect(signRoomPacket({ ...f.write, signature: '0'.repeat(128) } as RoomPacketWrite, f.key.signingPrivateKey)).rejects.toThrow();
    await expect(signRoomPacketRead({ ...f.read, limit: 9 }, f.key.signingPrivateKey)).rejects.toThrow();
    await expect(signRoomPacketRead({ ...f.read, afterStoredSeq: -0 }, f.key.signingPrivateKey)).rejects.toThrow();
    await expect(signRoomPacketRecovery({ ...f.recover, protocol: ROOM_PACKET_PROTOCOL } as unknown as RoomPacketRecovery,
      f.key.signingPrivateKey)).rejects.toThrow();
  });

  it('matches RFC 0005 framing/count limits without importing Noise in the wire module', async () => {
    expect(ROOM_PACKET_PROFILE).toBe(ROOM_NOISE_PROFILE);
    expect(ROOM_PACKET_LIMITS.packetBytes).toBe(ROOM_NOISE_LIMITS.plaintextBytes + 17);
    expect(ROOM_PACKET_LIMITS.lastPacketIndex - 1).toBe(ROOM_NOISE_LIMITS.messagesPerDirection);
    const f = await fixture();
    for (const [kind, packetIndex, bytes] of [
      ['handshake', 0, 96], ['handshake', 0, 48], ['confirmation', 1, 17], ['data', 2, 17],
      ['data', 1025, ROOM_PACKET_LIMITS.packetBytes],
    ] as const) {
      const wire = await signRoomPacket({ ...f.write, kind, packetIndex, packetHex: 'ab'.repeat(bytes) }, f.key.signingPrivateKey);
      expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(ROOM_PACKET_LIMITS.wireBytes);
      expect((await prepareRoomPacket(wire, context)).ok).toBe(true);
    }
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/packet-wire.ts', import.meta.url))],
      bundle: true, write: false, format: 'esm', platform: 'neutral', metafile: true });
    expect(Object.values(bundle.metafile!.outputs).every(output => output.imports.length === 0)).toBe(true);
    expect(Object.keys(bundle.metafile!.inputs).some(path => /noise|sqlite|libsodium|node:/.test(path))).toBe(false);
  });

  it('rejects byte, hex, phase-index and numeric violations before crypto', async () => {
    const s = await operation('write'); const p = JSON.parse(s.wire);
    const variants = [
      { packetHex: '' }, { packetHex: 'ab'.repeat(16) }, { packetHex: 'ab'.repeat(16_402) },
      { packetHex: 'AB'.repeat(17) }, { packetHex: 'ab'.repeat(17) + 'c' }, { packetHex: 'xz'.repeat(17) },
      { kind: 'handshake', packetIndex: 0, packetHex: 'ab'.repeat(17) },
      { kind: 'handshake', packetIndex: 1, packetHex: 'ab'.repeat(96) },
      { kind: 'confirmation', packetIndex: 1, packetHex: 'ab'.repeat(48) },
      { kind: 'confirmation', packetIndex: 0 }, { kind: 'data', packetIndex: 1 },
      { packetIndex: 1026 }, { packetIndex: -1 }, { packetIndex: 2.5 }, { expectedRevision: 0 },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { sessionId: 'short' }, { requestId: 'A'.repeat(32) },
      { profile: 'auto' }, { kind: 'execute' },
    ];
    const spy = vi.spyOn(crypto.subtle, 'verify');
    for (const patch of variants) expect(await prepareRoomPacket(canonicalizeJson({ ...p, ...patch }), context))
      .toEqual({ ok: false, reason: 'invalid_schema' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('bounds signed read pagination without treating relay cursors as sender counters', async () => {
    const s = await operation('read');
    const p = JSON.parse(s.wire);
    for (const patch of [{ limit: 0 }, { limit: 9 }, { limit: 1.5 }, { afterStoredSeq: -1 },
      { afterStoredSeq: Number.MAX_SAFE_INTEGER + 1 }, { expectedRevision: 0 }]) {
      expect(await prepareRoomPacketRead(canonicalizeJson({ ...p, ...patch }), context))
        .toEqual({ ok: false, reason: 'invalid_schema' });
    }
    const wire = await signRoomPacketRead({ ...s.read, limit: 1, afterStoredSeq: Number.MAX_SAFE_INTEGER }, s.key.signingPrivateKey);
    expect((await prepareRoomPacketRead(wire, context)).ok).toBe(true);
  });

  it('distinguishes historical sender authentication from freshness and any membership/receipt claim', async () => {
    const s = await operation('write'); // No room has been created, let alone authorized.
    const admittedNowhere = await prepareRoomPacket(s.wire, context);
    expect(admittedNowhere.ok).toBe(true);
    expect(await prepareRoomPacket(s.wire, { hub: HUB, now: NOW + 60_000 })).toEqual({ ok: false, reason: 'expired_proof' });
    expect(await verifyHistoricalRoomPacketSignature(s.wire, HUB)).toMatchObject({ ok: true, request: s.write });
    expect((await verifyHistoricalRoomPacketSignature(s.wire, 'https://other.example.com')).ok).toBe(false);
    const changed = canonicalizeJson({ ...JSON.parse(s.wire), packetHex: 'cd'.repeat(17) });
    expect((await verifyHistoricalRoomPacketSignature(changed, HUB)).ok).toBe(false);
    const p = await prepareRoomPacket(s.wire, context);
    if (!p.ok) throw new Error('Fixture verification failed');
    const recovery = { ...s.recover, proofDigest: p.proofDigest };
    expect((await prepareRoomPacketRecovery(await signRoomPacketRecovery(recovery, s.key.signingPrivateKey), context)).ok).toBe(true);
    expect(Object.keys(p).sort()).toEqual(['freshness', 'ok', 'proofDigest', 'request']);
  });

  it('carries real offline Noise flights and both application directions without altering packet bytes', async () => {
    const f = await admissionFixture();
    const sessions: RoomNoiseSession[] = [];
    try {
      const created = await f.create(); const invited = await f.invite(created.state);
      const accept = await actionFor(f.peer, 'accept', NOW, invited.state);
      admitted(await f.submit(accept, f.peer));
      const bundle = { create: await f.wire(created.action), invite: await f.wire(invited.action),
        accept: await f.wire(accept, f.peer) };
      const pins = { hub: HUB, roomId: created.state.roomId,
        ownerSigningPublicKey: f.owner.signingPublicKey, peerSigningPublicKey: f.peer.signingPublicKey };
      for (const role of ['owner', 'peer'] as const) sessions.push(await createRoomNoiseSession({
        role, bundle, pins, encryptionPrivateKey: f[role].encryptionPrivateKey, now: () => f.clock.now,
      }));
      const [owner, peer] = sessions;
      const base = (await fixture()).write;
      let requestCounter = 0;
      const wrap = async (packet: Buffer | null, role: 'owner' | 'peer', packetIndex: number, kind: RoomPacketWrite['kind']) => {
        if (!packet) throw new Error('Expected packet');
        const actor = f[role]; const before = Buffer.from(packet);
        const request: RoomPacketWrite = { ...base, roomId: created.state.roomId, actor: actor.agentId,
          signingPublicKey: actor.signingPublicKey, requestId: (++requestCounter).toString(16).padStart(32, '0'),
          packetIndex, kind, packetHex: packet.toString('hex') };
        const wire = await signRoomPacket(request, actor.signingPrivateKey);
        const prepared = await prepareRoomPacket(wire, context);
        if (!prepared.ok) throw new Error('Fixture proof failed');
        expect(prepared.request).toEqual(request);
        expect(packet.equals(before)).toBe(true);
        return Buffer.from(prepared.request.packetHex, 'hex');
      };
      const first = await wrap(owner.start(), 'owner', 0, 'handshake');
      const second = await wrap(peer.receiveHandshake(first), 'peer', 0, 'handshake');
      const third = await wrap(owner.receiveHandshake(second), 'owner', 1, 'confirmation');
      const fourth = await wrap(peer.receiveHandshake(third), 'peer', 1, 'confirmation');
      expect(owner.receiveHandshake(fourth)).toBeNull();
      expect([owner.phase, peer.phase]).toEqual(['ready', 'ready']);
      const large = Buffer.alloc(ROOM_NOISE_LIMITS.plaintextBytes, 0x61);
      expect(peer.open(await wrap(owner.seal(large), 'owner', 2, 'data')).equals(large)).toBe(true);
      expect(owner.open(await wrap(peer.seal(Buffer.alloc(0)), 'peer', 2, 'data')).length).toBe(0);
      admitted(await f.submit(await actionFor(f.peer, 'close', NOW, f.room(created.state.roomId)), f.peer));
      // Signing and offline encryption still work after closure. A future store MUST deny access.
      expect(f.room(created.state.roomId).status).toBe('closed');
      expect(peer.open(await wrap(owner.seal(Buffer.from('untrusted data')), 'owner', 3, 'data')).toString())
        .toBe('untrusted data');
    } finally {
      for (const session of sessions) session.close();
      f.close();
    }
  });
});
