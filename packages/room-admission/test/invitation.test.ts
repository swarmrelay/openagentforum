import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { generateAgentKeyPair, signEnvelope, sha256Hex } from '@openagentforum/protocol';
import { RoomInvitationMailbox } from '../src/invitation-mailbox.js';
import { RoomLocalState } from '../src/local-state.js';
import { readRoomInvitation, invitationScope, type RoomInvitationOffer, type RoomInvitationAcceptance } from '../src/invitation-wire.js';
import { ROOM_CONTROL_PROTOCOL, deriveRoomId, roomControlSignString, signRoomControl, type RoomControlAction } from '../src/control.js';
import { DatabaseSync } from './fixtures.js';
import { LOCAL_DB_NAME } from '../src/local-files.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
const hub = 'https://relay.example.com', id = () => randomBytes(16).toString('hex');
const policy = { rooms: 10, sessions: 20, controls: 100, packets: 1000, packetBytes: 1000000, setups: 10, setupBytes: 1000000 };
async function setup() {
  const [owner, peer] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
  const scope = { hub, channel: 'room-setup-' + id() };
  const records: any[] = [], requests: { url: string; init: RequestInit }[] = [];
  let drop = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    if (init?.method === 'GET') return Response.json({ messages: records });
    const envelope = JSON.parse(String(init?.body)); records.push(envelope);
    if (drop) { drop = false; throw new Error('PRIVATE remote diagnostics'); }
    return Response.json({ success: true, envelope });
  });
  const dirs = [owner, peer].map(() => {
    const dir = mkdtempSync(join(tmpdir(), 'oaf-room-invitation-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir;
  });
  const stores = [owner, peer].map((who, i) => {
    const state = RoomLocalState.initialize(dirs[i], { hub, signingPrivateKey: who.signingPrivateKey, policy });
    cleanup.push(() => state.close()); return state;
  });
  const a = await stores[0].createInvitationMailbox(peer.signingPublicKey, 'owner', scope.channel, fetcher);
  const b = await stores[1].createInvitationMailbox(owner.signingPublicKey, 'peer', scope.channel, fetcher);
  const requestId = id(), roomId = await deriveRoomId(hub, owner.agentId, requestId), now = Date.now();
  const c: RoomControlAction = { protocol: ROOM_CONTROL_PROTOCOL, hub, roomId, actor: owner.agentId, requestId,
    issuedAt: now, expiresAt: now + 60000, expectedRevision: 0, action: 'create',
    payload: { encryptionPublicKey: stores[0].createRoomKey(roomId).publicKey } };
  const i: RoomControlAction = { ...c, requestId: id(), expectedRevision: 1, action: 'invite',
    payload: { recipient: peer.agentId, recipientSigningPublicKey: peer.signingPublicKey, inviteExpiresAt: now + 120000 } };
  const accept: RoomControlAction = { ...c, requestId: id(), actor: peer.agentId, expectedRevision: 2, action: 'accept',
    payload: { invitationDigest: await sha256Hex(roomControlSignString(i)), encryptionPublicKey: stores[1].createRoomKey(roomId).publicKey } };
  const offer: RoomInvitationOffer = { kind: 'oaf.room.offer.v1', sessionId: id(), create: await signRoomControl(c, owner.signingPrivateKey),
    invite: await signRoomControl(i, owner.signingPrivateKey) };
  const accepted: RoomInvitationAcceptance = { ...offer, kind: 'oaf.room.accept.v1', accept: await signRoomControl(accept, peer.signingPrivateKey) };
  const keys = async () => {
    const keyA = await a.prepareKey(), keyB = await b.prepareKey(); await a.post(keyA); await b.post(keyB);
    expect(await a.findPeerKey()).toBe(true); expect(await b.findPeerKey()).toBe(true); return { keyA, keyB };
  };
  return { owner, peer, scope, a, b, stores, dirs, requests, records, fetcher, keys, offer, accepted, c, i, accept, roomId,
    drop() { drop = true; } };
}

it('exchanges encrypted, bound invitation/acceptance without exposing room details or implicitly accepting', async () => {
  const s = await setup(); expect(s.fetcher).not.toHaveBeenCalled(); await s.keys();
  const wire = await s.a.prepare(s.offer); expect(wire).not.toContain(s.roomId); expect(wire).not.toContain(s.offer.sessionId);
  expect(s.requests).toHaveLength(4); await s.a.post(wire);
  const before = s.requests.length; expect(await s.b.find()).toEqual(s.offer);
  expect(s.requests.slice(before).map(r => r.init.method)).toEqual(['GET']);
  expect(s.stores[1].pending()).toEqual([]); // no implicit room control, signing, key creation or session mutation
  const acceptance = await s.b.prepare(s.accepted); await s.b.post(acceptance);
  expect(await s.a.find()).toEqual(s.accepted);
  expect(s.records.filter(r => r.type === 'e2ee_blob')).toHaveLength(2);
  expect(JSON.stringify(s.records)).not.toContain(s.roomId);
  expect(JSON.stringify(s.records)).not.toContain(s.offer.sessionId);
  for (const { url, init } of s.requests) {
    expect(url.startsWith(hub + '/v1/channels/' + s.scope.channel + '/messages')).toBe(true);
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
  }
});

it('durably reserves before a lost setup response, never retries and cannot recreate the channel after restart', async () => {
  const s = await setup(), wire = await s.a.prepareKey(); s.drop();
  await expect(s.a.post(wire)).rejects.toMatchObject({ permitsReplacementMutation: false });
  expect(s.stores[0].invitationAttempt(s.scope.channel).keyWire).toBe(wire);
  await expect(s.a.post(wire)).rejects.toThrow(); expect(s.fetcher).toHaveBeenCalledTimes(1);
  s.stores[0].close(); expect(s.a.closed).toBe(true);
  const reopened = RoomLocalState.open(s.dirs[0], { hub, signingPublicKey: s.owner.signingPublicKey, policy });
  cleanup.push(() => reopened.close());
  expect(reopened.invitationAttempt(s.scope.channel).keyWire).toBe(wire);
  await expect(reopened.createInvitationMailbox(s.peer.signingPublicKey, 'owner', s.scope.channel, s.fetcher)).rejects.toThrow();
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});

it.each(['before', 'after'])('a local reservation COMMIT failure %s commit causes no POST and preserves uncertainty', async phase => {
  const s = await setup(), wire = await s.a.prepareKey(), original = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    if (sql === 'COMMIT') { if (phase === 'after') original.call(this, sql); throw new Error('PRIVATE path'); }
    return original.call(this, sql);
  });
  await expect(s.a.post(wire)).rejects.toThrow(); spy.mockRestore(); expect(s.fetcher).not.toHaveBeenCalled();
  const reopened = RoomLocalState.open(s.dirs[0], { hub, signingPublicKey: s.owner.signingPublicKey, policy }); cleanup.push(() => reopened.close());
  expect(reopened.invitationAttempt(s.scope.channel).keyWire).toBe(phase === 'after' ? wire : null);
  await expect(reopened.createInvitationMailbox(s.peer.signingPublicKey, 'owner', s.scope.channel, s.fetcher)).rejects.toThrow();
});

it('rejects legacy local schema without altering its retained control record', async () => {
  const s = await setup(); await s.stores[0].retainControl(s.offer.create); s.stores[0].close();
  let db = new DatabaseSync(join(s.dirs[0], LOCAL_DB_NAME)); db.exec('PRAGMA user_version=1'); db.close();
  expect(() => RoomLocalState.open(s.dirs[0], { hub, signingPublicKey: s.owner.signingPublicKey, policy })).toThrow();
  db = new DatabaseSync(join(s.dirs[0], LOCAL_DB_NAME));
  try { expect(db.prepare('SELECT wire FROM client_ops').get()?.wire).toBe(s.offer.create);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1); } finally { db.close(); }
});

it.each(['nonce', 'flag', 'cursor', 'reply'])('ignores unsigned %s metadata when decrypting', async variant => {
  const s = await setup(); await s.keys(); await s.a.post(await s.a.prepare(s.offer));
  const record = s.records.at(-1);
  if (variant === 'nonce') record.nonce = '00'.repeat(12);
  if (variant === 'flag') record.encrypted = false;
  if (variant === 'cursor') record.storedSeq = Number.MAX_SAFE_INTEGER;
  if (variant === 'reply') record.replyToId = 'anything';
  expect(await s.b.find()).toEqual(s.offer);
});

it.each(['signature', 'ciphertext', 'signed nonce'])('rejects corrupted %s rather than falling back to plaintext', async variant => {
  const s = await setup(); await s.keys(); await s.a.post(await s.a.prepare(s.offer));
  const record = s.records.at(-1);
  if (variant === 'signature') record.signature = '00'.repeat(64);
  if (variant === 'ciphertext') record.payload.ciphertext = '00'.repeat(100);
  if (variant === 'signed nonce') {
    const ciphertext = record.payload.ciphertext;
    s.records[s.records.length - 1] = await signEnvelope({ channel: s.scope.channel, sender: s.owner.agentId, type: 'e2ee_blob',
      sequence: 1, payload: { ciphertext: ciphertext.slice(0, 8) + '00'.repeat(12) + ciphertext.slice(32) } }, s.owner.signingPrivateKey);
  }
  expect(await s.b.find()).toBeNull();
});

it('fails on a full history page and rejects multiple valid keys from the selected peer', async () => {
  const s = await setup(); const kA = await s.a.prepareKey(), kB = await s.b.prepareKey(); await s.a.post(kA); await s.b.post(kB);
  const old = JSON.parse(kB);
  s.records.push(await signEnvelope({ channel: s.scope.channel, sender: s.peer.agentId, type: 'intel', sequence: 0,
    payload: { ...old.payload, encryptionPublicKey: s.owner.encryptionPublicKey } }, s.peer.signingPrivateKey));
  await expect(s.a.findPeerKey()).rejects.toThrow();
  while (s.records.length < 100) s.records.push({});
  await expect(s.a.findPeerKey()).rejects.toThrow();
});

it.each(['session', 'invite', 'key', 'fields', 'hub', 'expired'])('rejects substituted %s in private control handoff', async variant => {
  const s = await setup(); await s.keys(); await s.a.post(await s.a.prepare(s.offer)); expect(await s.b.find()).toEqual(s.offer);
  const changed: any = { ...s.accepted };
  if (variant === 'session') changed.sessionId = id();
  if (variant === 'invite') changed.invite = await signRoomControl({ ...s.i, requestId: id() }, s.owner.signingPrivateKey);
  if (variant === 'key') changed.accept = await signRoomControl(s.accept, s.owner.signingPrivateKey);
  if (variant === 'fields') changed.command = 'never execute';
  if (variant === 'hub') changed.invite = await signRoomControl({ ...s.i, hub: 'https://other.example.com' }, s.owner.signingPrivateKey);
  if (variant === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
  await expect(s.b.prepare(changed)).rejects.toThrow();
});

it('requires explicit role/full keys and an exact HTTPS origin with a random setup locator', async () => {
  const s = await setup();
  for (const bad of [{ hub: 'http://relay.example.com', channel: s.scope.channel }, { hub: hub + '/', channel: s.scope.channel },
    { hub, channel: 'general' }, { hub, channel: 'dm-secret' }]) expect(() => invitationScope(bad)).toThrow();
  await expect(RoomInvitationMailbox.create(s.owner, s.owner.signingPublicKey, 'owner', s.scope, { async reserve() {} })).rejects.toThrow();
  await expect(readRoomInvitation(JSON.stringify(s.offer), hub, s.peer.signingPublicKey, s.owner.signingPublicKey)).rejects.toThrow();
  expect(s.fetcher).not.toHaveBeenCalled();
});

it('read-only discovery returns a fingerprint-checked candidate, never registers or trusts its name', async () => {
  const s = await setup(), fetcher = vi.fn<typeof fetch>(async () => Response.json({ agent: {
    publicKey: s.peer.signingPublicKey, displayName: 'untrusted', encryptionPublicKey: s.owner.encryptionPublicKey } }));
  expect(await RoomInvitationMailbox.discover(s.scope, s.peer.agentId, fetcher)).toBe(s.peer.signingPublicKey);
  expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
  await expect(RoomInvitationMailbox.discover(s.scope, s.owner.agentId, fetcher)).rejects.toThrow();
});

it.each(['setups', 'setupBytes'])('bounds %s independently of retained room control/close capacity', async field => {
  const s = await setup(); s.stores[0].close();
  const dir = mkdtempSync(join(tmpdir(), 'oaf-room-invitation-cap-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const limits = { ...policy, [field]: 1 };
  let state = RoomLocalState.initialize(dir, { hub, signingPrivateKey: s.owner.signingPrivateKey, policy: limits }); cleanup.push(() => state.close());
  const m = await state.createInvitationMailbox(s.peer.signingPublicKey, 'owner', s.scope.channel, s.fetcher);
  if (field === 'setups') await expect(state.createInvitationMailbox(s.peer.signingPublicKey, 'owner', 'room-setup-' + id(), s.fetcher)).rejects.toThrow();
  else await expect(m.post(await m.prepareKey())).rejects.toThrow();
  state = RoomLocalState.open(dir, { hub, signingPublicKey: s.owner.signingPublicKey, policy: limits });
  state.createRoomKey(s.roomId);
  await state.retainControl(await signRoomControl({ ...s.c, action: 'close', expectedRevision: 3, requestId: id(), payload: {} }, s.owner.signingPrivateKey));
  expect(state.pending()).toHaveLength(1); expect(s.fetcher).not.toHaveBeenCalled();
});

it('closing during a pending durable reservation prevents a late POST', async () => {
  const s = await setup(); let release!: () => void;
  const mailbox = await RoomInvitationMailbox.create(s.owner, s.peer.signingPublicKey, 'owner', s.scope,
    { reserve() { return new Promise<void>(resolve => { release = resolve; }); } }, s.fetcher);
  const wire = await mailbox.prepareKey(), pending = mailbox.post(wire);
  mailbox.close(); release(); await expect(pending).rejects.toThrow(); expect(s.fetcher).not.toHaveBeenCalled();
});

it.each(['redirect', 'oversize', 'utf8', 'malformed', 'wrong origin'])('bounds/refuses %s HTTP discovery responses', async variant => {
  const s = await setup();
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (variant === 'redirect') return new Response('', { status: 302, headers: { location: 'https://other.example.com' } });
    if (variant === 'oversize') return new Response('x'.repeat(262145), { headers: { 'content-type': 'application/json' } });
    if (variant === 'utf8') return new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } });
    if (variant === 'malformed') return Response.json({ agent: { publicKey: '00' } });
    const response = Response.json({ agent: { publicKey: s.peer.signingPublicKey } });
    Object.defineProperty(response, 'url', { value: 'https://other.example.com/v1/agents/' + s.peer.agentId }); return response;
  });
  await expect(RoomInvitationMailbox.discover(s.scope, s.peer.agentId, fetcher)).rejects.toThrow('Private invitation unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('bounds stalled HTTP headers even when an embedding fetch ignores cancellation', async () => {
  const s = await setup(); vi.useFakeTimers();
  try {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const pending = expect(RoomInvitationMailbox.discover(s.scope, s.peer.agentId, fetcher)).rejects.toThrow('Private invitation unavailable');
    await vi.advanceTimersByTimeAsync(5001); await pending;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('rejects replay into a new setup channel or restarted ephemeral-key instance', async () => {
  const s = await setup(); await s.keys(); await s.a.post(await s.a.prepare(s.offer));
  const freshScope = { hub, channel: 'room-setup-' + id() };
  const next = await RoomInvitationMailbox.create(s.peer, s.owner.signingPublicKey, 'peer', freshScope,
    { async reserve() {} }, s.fetcher); cleanup.push(() => next.close());
  await next.post(await next.prepareKey()); expect(await next.findPeerKey()).toBe(false);
  // Even with the original channel, different ephemeral key announcements cannot decrypt old setup.
  const restart = await RoomInvitationMailbox.create(s.peer, s.owner.signingPublicKey, 'peer', s.scope,
    { async reserve() {} }, s.fetcher); cleanup.push(() => restart.close());
  await restart.post(await restart.prepareKey()); expect(await restart.findPeerKey()).toBe(true); expect(await restart.find()).toBeNull();
});
