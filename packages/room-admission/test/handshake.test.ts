import { createDecipheriv, createPrivateKey } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeJson, type AgentKeyPair } from '@openagentforum/protocol';
import { createRoomNoiseSession, ROOM_NOISE_LIMITS, type RoomNoiseOptions, type RoomNoiseSession } from '../src/handshake.js';
import { roomNoisePrologue, verifyRoomKeyBindings, type RoomKeyBundle, type RoomKeyPins } from '../src/key-bindings.js';
import { Cipher, Noise, clearNoise, type NoiseState } from '../src/noise-driver.js';
import { actionFor, admitted, fixture, HUB, START } from './fixtures.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
async function setup() {
  const f = await fixture();
  cleanup.push(() => f.close());
  const created = await f.create();
  const invited = await f.invite(created.state);
  const accepted = await actionFor(f.peer, 'accept', START, invited.state);
  admitted(await f.submit(accepted, f.peer));
  const bundle: RoomKeyBundle = { create: await f.wire(created.action), invite: await f.wire(invited.action),
    accept: await f.wire(accepted, f.peer) };
  const pins: RoomKeyPins = { hub: HUB, roomId: created.state.roomId,
    ownerSigningPublicKey: f.owner.signingPublicKey, peerSigningPublicKey: f.peer.signingPublicKey };
  return { f, created, invited, accepted, bundle, pins };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function session(s: Setup, role: 'owner' | 'peer', patch: Partial<RoomNoiseOptions> = {}) {
  const result = await createRoomNoiseSession({ role, bundle: s.bundle, pins: s.pins,
    encryptionPrivateKey: s.f[role].encryptionPrivateKey, now: () => s.f.clock.now, ...patch });
  cleanup.push(() => result.close());
  return result;
}
function packet(value: Buffer | null): Buffer {
  if (!value) throw new Error('Expected handshake packet');
  return value;
}
async function pair(s: Setup) {
  return { owner: await session(s, 'owner'), peer: await session(s, 'peer') };
}
function connect({ owner, peer }: { owner: RoomNoiseSession; peer: RoomNoiseSession }) {
  const first = owner.start();
  const second = packet(peer.receiveHandshake(first));
  const third = packet(owner.receiveHandshake(second));
  expect(owner.phase).toBe('owner-confirm');
  expect(peer.phase).toBe('peer-confirm');
  const fourth = packet(peer.receiveHandshake(third));
  expect(owner.receiveHandshake(fourth)).toBeNull();
  expect([owner.phase, peer.phase]).toEqual(['ready', 'ready']);
  return [first, second, third, fourth];
}
function raw(initiator: boolean, actor: AgentKeyPair, prologue: Buffer, remoteKey: string) {
  const key = createPrivateKey({ key: Buffer.from(actor.encryptionPrivateKey, 'hex'), format: 'der', type: 'pkcs8' });
  const state = new Noise('IK', initiator, { publicKey: Buffer.from(actor.encryptionPublicKey, 'hex'),
    secretKey: Buffer.from(key.export({ format: 'jwk' }).d!, 'base64url') });
  cleanup.push(() => clearNoise(state));
  state.initialise(prologue, Buffer.from(remoteKey, 'hex'));
  return state;
}
function split(state: NoiseState) {
  if (!state.complete || !state.tx || !state.rx) throw new Error('Incomplete reference handshake');
  const tx = new Cipher(Buffer.from(state.tx)), rx = new Cipher(Buffer.from(state.rx));
  cleanup.push(() => { tx.key?.fill(0); rx.key?.fill(0); });
  return { tx, rx };
}
async function referencePeer(s: Setup) {
  const owner = await session(s, 'owner');
  const binding = await verifyRoomKeyBindings(s.bundle, s.pins);
  const state = raw(false, s.f.peer, roomNoisePrologue(binding), s.f.owner.encryptionPublicKey);
  expect(state.recv(owner.start()).length).toBe(0);
  const confirmation = packet(owner.receiveHandshake(state.send()));
  const { tx, rx } = split(state);
  expect(rx.decrypt(confirmation).equals(Buffer.from([1]))).toBe(true);
  expect(owner.receiveHandshake(tx.encrypt(Buffer.from([2])))).toBeNull();
  return { owner, tx, rx };
}

describe('historical room identity/key bindings, not a CA or current authorization', () => {
  it('pins full signing keys and immutable signed room-key bindings', async () => {
    const s = await setup();
    const binding = await verifyRoomKeyBindings(s.bundle, s.pins);
    expect(binding.owner.signingPublicKey).toBe(s.f.owner.signingPublicKey);
    expect(binding.peer.encryptionPublicKey).toBe(s.f.peer.encryptionPublicKey);
    expect(binding.acceptedRevision).toBe(3);
    expect(Object.isFrozen(binding) && Object.isFrozen(binding.owner) && Object.isFrozen(binding.peer)).toBe(true);
    expect(roomNoisePrologue(binding).toString()).toBe(`${binding.profile}\n${canonicalizeJson(binding)}`);
  });

  it.each(['owner', 'peer', 'short-id', 'same-identity', 'hub', 'room', 'extra'] as const)
  ('rejects wrong trusted pins: %s', async field => {
    const s = await setup();
    const pins = { ...s.pins };
    if (field === 'owner') pins.ownerSigningPublicKey = s.f.outsider.signingPublicKey;
    if (field === 'peer') pins.peerSigningPublicKey = s.f.outsider.signingPublicKey;
    if (field === 'short-id') pins.ownerSigningPublicKey = s.f.owner.agentId;
    if (field === 'same-identity') pins.peerSigningPublicKey = pins.ownerSigningPublicKey;
    if (field === 'hub') pins.hub = 'https://other.example.com';
    if (field === 'room') pins.roomId = `room_${'f'.repeat(32)}`;
    if (field === 'extra') Object.assign(pins, { verified: true });
    await expect(verifyRoomKeyBindings(s.bundle, pins)).rejects.toThrow('Invalid room key binding');
  });

  it.each(['signature', 'whitespace', 'duplicate-key', 'oversize', 'missing', 'extra'] as const)
  ('rejects malformed bundle: %s', async field => {
    const s = await setup();
    const bundle = { ...s.bundle };
    if (field === 'signature') {
      const proof = JSON.parse(bundle.accept); proof.signature = '0'.repeat(128);
      bundle.accept = canonicalizeJson(proof);
    }
    if (field === 'whitespace') bundle.create += ' ';
    if (field === 'duplicate-key') bundle.invite = `{"action":"invite",${bundle.invite.slice(1)}`;
    if (field === 'oversize') bundle.accept = 'x'.repeat(4097);
    if (field === 'missing') delete (bundle as Partial<RoomKeyBundle>).accept;
    if (field === 'extra') Object.assign(bundle, { verified: true });
    await expect(verifyRoomKeyBindings(bundle, s.pins)).rejects.toThrow('Invalid room key binding');
  });

  it.each(['room', 'revision', 'digest', 'same-x25519', 'recipient-key', 'request-id'] as const)
  ('rejects individually signed but inconsistent bindings: %s', async field => {
    const s = await setup();
    const a = structuredClone(s.accepted), i = structuredClone(s.invited.action);
    if (a.action !== 'accept' || i.action !== 'invite') throw new Error('Wrong fixture action');
    if (field === 'room') a.roomId = `room_${'f'.repeat(32)}`;
    if (field === 'revision') a.expectedRevision++;
    if (field === 'digest') a.payload.invitationDigest = '0'.repeat(64);
    if (field === 'same-x25519') a.payload.encryptionPublicKey = s.f.owner.encryptionPublicKey;
    if (field === 'recipient-key') i.payload.recipientSigningPublicKey = s.f.outsider.signingPublicKey;
    if (field === 'request-id') i.requestId = s.created.action.requestId;
    const bundle = { ...s.bundle, invite: await s.f.wire(i), accept: await s.f.wire(a, s.f.peer) };
    await expect(verifyRoomKeyBindings(bundle, s.pins)).rejects.toThrow('Invalid room key binding');
  });

  it('snapshots raw inputs before asynchronous verification', async () => {
    const s = await setup();
    const pending = verifyRoomKeyBindings(s.bundle, s.pins);
    s.bundle.accept = 'invalid'; s.pins.peerSigningPublicKey = s.f.outsider.signingPublicKey;
    expect((await pending).peer.signingPublicKey).toBe(s.f.peer.signingPublicKey);
  });

  it('can verify old bindings after closure/expiry but cannot revive admission or change storage', async () => {
    const s = await setup();
    admitted(await s.f.submit(await actionFor(s.f.peer, 'close', START, s.f.room(s.pins.roomId)), s.f.peer));
    s.f.clock.now += 600_000;
    s.f.restart();
    const before = s.f.counts();
    const p = await pair(s); connect(p);
    expect(p.peer.open(p.owner.seal(Buffer.from('offline only'))).toString()).toBe('offline only');
    expect(s.f.counts()).toEqual(before);
    expect(s.f.room(s.pins.roomId).status).toBe('closed');
    expect(await s.f.store.submit(s.bundle.accept, s.f.peer.signingPublicKey))
      .toEqual({ ok: false, reason: 'expired_proof' });
    const fresh = await actionFor(s.f.peer, 'close', s.f.clock.now, s.f.room(s.pins.roomId));
    expect(await s.f.submit(fresh, s.f.peer)).toEqual({ ok: false, reason: 'room_closed' });
  });
});

describe('offline Noise IK session', () => {
  it('confirms both directions, preserves caller buffers and encrypts empty, binary and bounded data', async () => {
    const s = await setup(), p = await pair(s);
    const first = p.owner.start(), savedFirst = Buffer.from(first);
    const second = packet(p.peer.receiveHandshake(first)), savedSecond = Buffer.from(second);
    const third = packet(p.owner.receiveHandshake(second));
    const fourth = packet(p.peer.receiveHandshake(third));
    expect(p.owner.receiveHandshake(fourth)).toBeNull();
    expect(first.equals(savedFirst) && second.equals(savedSecond)).toBe(true);
    expect([first.length, second.length, third.length, fourth.length]).toEqual([96, 48, 17, 17]);
    for (const body of [Buffer.alloc(0), Buffer.from([0, 1, 255, 7]), Buffer.alloc(ROOM_NOISE_LIMITS.plaintextBytes, 97)]) {
      const saved = Buffer.from(body), wire = p.owner.seal(body), savedWire = Buffer.from(wire);
      expect(wire.length).toBe(body.length + 17);
      expect(p.peer.open(wire).equals(body)).toBe(true);
      expect(p.owner.open(p.peer.seal(body)).equals(body)).toBe(true);
      expect(body.equals(saved) && wire.equals(savedWire)).toBe(true);
      if (body.length > 32) expect(wire.includes(body)).toBe(false);
    }
    const body = Buffer.from('same plaintext'), a = p.owner.seal(body), b = p.owner.seal(body);
    expect(a.equals(b)).toBe(false);
    expect(p.peer.open(a).equals(p.peer.open(b))).toBe(true);
  });

  it.each(['owner', 'peer'] as const)('rejects application use before %s confirmation', async role => {
    const s = await setup(), p = await pair(s);
    p.owner.receiveHandshake(packet(p.peer.receiveHandshake(p.owner.start())));
    expect(() => p[role].seal(Buffer.from('too early'))).toThrow('Room session failed or closed');
    expect(p[role].phase).toBe('closed');
  });

  it.each([0, 1, 2, 3])('rejects tampering in handshake flight %i and stays closed', async stage => {
    const p = await pair(await setup());
    let wire = p.owner.start();
    for (let n = 0; n < stage; n++) wire = packet((n % 2 ? p.owner : p.peer).receiveHandshake(wire));
    wire[wire.length - 1] ^= 1;
    const target = stage % 2 ? p.owner : p.peer;
    expect(() => target.receiveHandshake(wire)).toThrow('Room session failed or closed');
    expect(target.phase).toBe('closed');
    expect(() => target.start()).toThrow('Room session failed or closed');
  });

  it.each(['truncated', 'oversized', 'shared', 'object', 'low-order'] as const)
  ('rejects invalid first flight: %s', async kind => {
    const p = await pair(await setup());
    let wire: Uint8Array = p.owner.start();
    if (kind === 'truncated') wire = wire.subarray(0, 95);
    if (kind === 'oversized') wire = Buffer.concat([wire, Buffer.from([0])]);
    if (kind === 'shared') { const shared = new Uint8Array(new SharedArrayBuffer(96)); shared.set(wire); wire = shared; }
    if (kind === 'object') wire = { byteLength: 96 } as Uint8Array;
    if (kind === 'low-order') wire.fill(0, 0, 32);
    expect(() => p.peer.receiveHandshake(wire)).toThrow('Room session failed or closed');
  });

  it('rejects a correctly authenticated Noise initiator whose actual static key is not the invited owner', async () => {
    const s = await setup(), peer = await session(s, 'peer');
    const binding = await verifyRoomKeyBindings(s.bundle, s.pins);
    const impostor = raw(true, s.f.outsider, roomNoisePrologue(binding), s.f.peer.encryptionPublicKey);
    expect(() => peer.receiveHandshake(impostor.send())).toThrow('Room session failed or closed');
  });

  it.each(['hub', 'roomId', 'profile', 'createDigest', 'inviteDigest', 'acceptDigest', 'acceptedRevision', 'owner', 'peer'] as const)
  ('binds the handshake transcript to %s', async field => {
    const s = await setup(), peer = await session(s, 'peer');
    const binding = { ...structuredClone(await verifyRoomKeyBindings(s.bundle, s.pins)) };
    if (field === 'owner' || field === 'peer') binding[field] = { ...binding[field], signingPublicKey: s.f.outsider.signingPublicKey };
    else if (field === 'acceptedRevision') binding.acceptedRevision++;
    else Object.assign(binding, { [field]: `different-${binding[field]}` });
    const other = raw(true, s.f.owner, roomNoisePrologue(binding), s.f.peer.encryptionPublicKey);
    expect(() => peer.receiveHandshake(other.send())).toThrow('Room session failed or closed');
  });

  it('rejects valid Noise early application data rather than processing it', async () => {
    const s = await setup(), peer = await session(s, 'peer');
    const binding = await verifyRoomKeyBindings(s.bundle, s.pins);
    const owner = raw(true, s.f.owner, roomNoisePrologue(binding), s.f.peer.encryptionPublicKey);
    expect(() => peer.receiveHandshake(owner.send(Buffer.from('early data')))).toThrow('Room session failed or closed');
  });

  it.each(['wrong-private', 'wrong-kind', 'invalid-der', 'invalid-role'] as const)
  ('rejects invalid local setup without reflecting secrets: %s', async kind => {
    const s = await setup();
    const patch: Partial<RoomNoiseOptions> = {};
    if (kind === 'wrong-private') patch.encryptionPrivateKey = s.f.outsider.encryptionPrivateKey;
    if (kind === 'wrong-kind') patch.encryptionPrivateKey = s.f.owner.signingPrivateKey;
    if (kind === 'invalid-der') patch.encryptionPrivateKey = 'aa';
    if (kind === 'invalid-role') patch.role = 'unknown' as RoomNoiseOptions['role'];
    await expect(session(s, 'owner', patch)).rejects.toThrow(/^Room handshake setup failed$/);
  });

  it('rejects a signed low-order responder key at DH, without emitting the first flight', async () => {
    const s = await setup();
    const accept = structuredClone(s.accepted);
    if (accept.action !== 'accept') throw new Error('Wrong fixture action');
    accept.payload.encryptionPublicKey = '0'.repeat(64);
    s.bundle.accept = await s.f.wire(accept, s.f.peer);
    const owner = await session(s, 'owner');
    expect(() => owner.start()).toThrow('Room session failed or closed');
    expect(owner.phase).toBe('closed');
  });

  it.each(['replay', 'out-of-order', 'reflection', 'tamper'] as const)
  ('rejects application %s without retrying or rewinding cipher state', async kind => {
    const p = await pair(await setup()); connect(p);
    const a = p.owner.seal(Buffer.from('a')), b = p.owner.seal(Buffer.from('b'));
    const target = kind === 'reflection' ? p.owner : p.peer;
    if (kind === 'replay') expect(p.peer.open(a).toString()).toBe('a');
    if (kind === 'tamper') a[a.length - 1] ^= 1;
    expect(() => target.open(kind === 'out-of-order' ? b : a)).toThrow('Room session failed or closed');
    expect(target.phase).toBe('closed');
    expect(() => target.open(a)).toThrow('Room session failed or closed');
  });

  it.each([0, 1, 2, 4])('rejects authenticated non-application frame type %i', async type => {
    const { owner, tx } = await referencePeer(await setup());
    expect(() => owner.open(tx.encrypt(Buffer.from([type])))).toThrow('Room session failed or closed');
  });

  it('enforces send and receive caps below the dependency counter boundary', async () => {
    const s = await setup(), p = await pair(s); connect(p);
    for (let i = 0; i < ROOM_NOISE_LIMITS.messagesPerDirection; i++) {
      expect(p.peer.open(p.owner.seal(Buffer.from('o'))).toString()).toBe('o');
      expect(p.owner.open(p.peer.seal(Buffer.from('p'))).toString()).toBe('p');
    }
    expect(() => p.owner.seal(Buffer.alloc(0))).toThrow('Room session failed or closed');
    expect(() => p.peer.seal(Buffer.alloc(0))).toThrow('Room session failed or closed');
    const ref = await referencePeer(s);
    for (let i = 0; i < ROOM_NOISE_LIMITS.messagesPerDirection; i++) ref.owner.open(ref.tx.encrypt(Buffer.from([3])));
    expect(() => ref.owner.open(ref.tx.encrypt(Buffer.from([3])))).toThrow('Room session failed or closed');
  });

  it.each(['seal', 'open'] as const)('bounds %s input size before crypto', async method => {
    const p = await pair(await setup()); connect(p);
    const oversized = Buffer.alloc(ROOM_NOISE_LIMITS.plaintextBytes + (method === 'open' ? 18 : 1));
    expect(() => p.owner[method](oversized)).toThrow('Room session failed or closed');
  });

  it('interoperates with the pinned driver and independently decrypts transport framing with Node crypto', async () => {
    const { owner, tx, rx } = await referencePeer(await setup());
    const body = Buffer.from('reference interoperability');
    const wire = owner.seal(body);
    // Confirmation consumed nonce 0. First application frame uses the standard nonce 1.
    const nonce = Buffer.alloc(12); nonce.writeUInt32LE(1, 4);
    const decipher = createDecipheriv('chacha20-poly1305', rx.key!, nonce, { authTagLength: 16 });
    decipher.setAuthTag(wire.subarray(-16));
    const clear = Buffer.concat([decipher.update(wire.subarray(0, -16)), decipher.final()]);
    try { expect(clear.equals(Buffer.concat([Buffer.from([3]), body]))).toBe(true); }
    finally { clear.fill(0); }
    expect(rx.decrypt(wire).equals(Buffer.concat([Buffer.from([3]), body]))).toBe(true);
    expect(owner.open(tx.encrypt(Buffer.concat([Buffer.from([3]), body]))).equals(body)).toBe(true);
  });

  it('uses fresh ephemeral sessions after restart and rejects ciphertext from the previous session', async () => {
    const s = await setup(), old = await pair(s), oldFlights = connect(old);
    const oldWire = old.owner.seal(Buffer.from('old session'));
    old.owner.close(); old.peer.close(); s.f.restart();
    const fresh = await pair(s), newFlights = connect(fresh);
    expect(oldFlights[0].equals(newFlights[0])).toBe(false);
    expect(() => fresh.peer.open(oldWire)).toThrow('Room session failed or closed');
    expect('restore' in fresh.owner || 'exportState' in fresh.owner).toBe(false);
  });

  it('requires fresh confirmation when an old first flight is replayed to a fresh responder', async () => {
    const s = await setup(), p = await pair(s), flights = connect(p);
    p.peer.close(); p.owner.close();
    const freshPeer = await session(s, 'peer');
    const reply = packet(freshPeer.receiveHandshake(flights[0]));
    expect(reply.equals(flights[1])).toBe(false);
    expect(freshPeer.phase).toBe('peer-confirm');
    expect(() => freshPeer.receiveHandshake(flights[2])).toThrow('Room session failed or closed');
  });

  it.each(['owner', 'peer'] as const)('rejects authenticated wrong-role confirmation at the %s', async role => {
    const s = await setup(), target = await session(s, role);
    const binding = await verifyRoomKeyBindings(s.bundle, s.pins);
    const otherRole = role === 'owner' ? 'peer' : 'owner';
    const other = raw(role === 'peer', s.f[otherRole], roomNoisePrologue(binding), s.f[role].encryptionPublicKey);
    if (role === 'owner') {
      other.recv(target.start());
      target.receiveHandshake(other.send());
    } else other.recv(packet(target.receiveHandshake(other.send())));
    const { tx } = split(other);
    const wrongRole = role === 'owner' ? 1 : 2;
    expect(() => target.receiveHandshake(tx.encrypt(Buffer.from([wrongRole])))).toThrow('Room session failed or closed');
  });

  it('makes duplicate/out-of-order handshake calls terminal and close idempotent', async () => {
    const s = await setup(), p = await pair(s);
    const first = p.owner.start(); p.peer.receiveHandshake(first);
    expect(() => p.peer.receiveHandshake(first)).toThrow('Room session failed or closed');
    expect(() => p.owner.start()).toThrow('Room session failed or closed');
    p.owner.close(); p.owner.close();
    const peer = await session(s, 'peer');
    expect(() => peer.start()).toThrow('Room session failed or closed');
  });

  it.each(['handshake', 'ready'] as const)('expires a %s session exactly at its deadline, permanently', async phase => {
    const s = await setup(), p = await pair(s);
    if (phase === 'ready') connect(p);
    s.f.clock.now += phase === 'ready' ? ROOM_NOISE_LIMITS.sessionLifetimeMs : ROOM_NOISE_LIMITS.handshakeLifetimeMs;
    const use = () => phase === 'ready' ? p.owner.seal(Buffer.alloc(0)) : p.owner.start();
    expect(use).toThrow('Room session failed or closed');
    s.f.clock.now = START;
    expect(use).toThrow('Room session failed or closed');
  });

  it('rechecks the handshake deadline before releasing confirmation, even when becoming ready', async () => {
    const s = await setup();
    let calls = 0, crossing = false;
    const owner = await session(s, 'owner', { now: () => crossing && ++calls > 1 ? START + 60_000 : START });
    const peer = await session(s, 'peer');
    const confirmation = packet(owner.receiveHandshake(packet(peer.receiveHandshake(owner.start()))));
    const final = packet(peer.receiveHandshake(confirmation));
    crossing = true;
    expect(() => owner.receiveHandshake(final)).toThrow('Room session failed or closed');
    expect(owner.phase).toBe('closed');
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid initial clock %s', async time => {
    await expect(session(await setup(), 'owner', { now: () => time })).rejects.toThrow('Room handshake setup failed');
  });

  it('fails closed on a faulty live clock, without reflecting the exception', async () => {
    const s = await setup(); let fail = false;
    const owner = await session(s, 'owner', { now: () => { if (fail) throw new Error('private diagnostic'); return START; } });
    fail = true;
    expect(() => owner.start()).toThrow(/^Room session failed or closed$/);
  });
});
