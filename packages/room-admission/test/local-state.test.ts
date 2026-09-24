import { mkdtempSync, mkdirSync, chmodSync, lstatSync, readdirSync, rmSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { generateAgentKeyPair, sha256Hex } from '@openagentforum/protocol';
import { RoomLocalState, type RoomLocalPolicy } from '../src/local-state.js';
import { LOCAL_DB_NAME } from '../src/local-files.js';
import { RoomHttpClient } from '../src/http-client.js';
import { ROOM_CONTROL_PROTOCOL, deriveRoomId, signRoomControl, roomControlSignString, type RoomControlAction } from '../src/control.js';
import { DatabaseSync } from './fixtures.js';
import type { AdmissionReceipt } from '../src/storage-types.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
const hub = 'https://relay.example.com';
const policy = (): RoomLocalPolicy => ({ rooms: 10, sessions: 20, controls: 100, packets: 1000, packetBytes: 10_000_000 });
const id = () => randomBytes(16).toString('hex');
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'oaf-room-custody-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
async function setup(patch: Partial<RoomLocalPolicy> = {}) {
  const directory = scratch(), identity = await generateAgentKeyPair(), other = await generateAgentKeyPair();
  const limits = { ...policy(), ...patch };
  const scope = { hub, signingPublicKey: identity.signingPublicKey, policy: limits };
  let state = RoomLocalState.initialize(directory, { hub, signingPrivateKey: identity.signingPrivateKey, policy: limits });
  cleanup.push(() => state.close());
  const requestId = id(), roomId = await deriveRoomId(hub, identity.agentId, requestId);
  const key = state.createRoomKey(roomId);
  const issuedAt = Date.now();
  const create: RoomControlAction = { protocol: ROOM_CONTROL_PROTOCOL, hub, actor: identity.agentId, roomId, requestId,
    issuedAt, expiresAt: issuedAt + 60_000, expectedRevision: 0, action: 'create', payload: { encryptionPublicKey: key.publicKey } };
  const wire = await signRoomControl(create, identity.signingPrivateKey);
  const receipt: AdmissionReceipt = { protocol: ROOM_CONTROL_PROTOCOL, hub, actor: identity.agentId, roomId, requestId,
    action: 'create' as const, revision: 1, status: 'open' as const, committedAt: issuedAt,
    proofDigest: await sha256Hex(roomControlSignString(create)) };
  const reopen = () => { state.close(); state = RoomLocalState.open(directory, scope); return state; };
  return { get state() { return state; }, directory, identity, other, scope, key, roomId, create, wire, receipt, reopen };
}
async function accepted(s: Awaited<ReturnType<typeof setup>>) {
  const invite: RoomControlAction = { ...s.create, requestId: id(), expectedRevision: 1, action: 'invite',
    payload: { recipient: s.other.agentId, recipientSigningPublicKey: s.other.signingPublicKey, inviteExpiresAt: s.create.issuedAt + 120_000 } };
  const accept: RoomControlAction = { ...s.create, requestId: id(), actor: s.other.agentId, expectedRevision: 2, action: 'accept',
    payload: { encryptionPublicKey: s.other.encryptionPublicKey, invitationDigest: await sha256Hex(roomControlSignString(invite)) } };
  const bundle = { create: s.wire, invite: await signRoomControl(invite, s.identity.signingPrivateKey),
    accept: await signRoomControl(accept, s.other.signingPrivateKey) };
  const pins = { hub, roomId: s.roomId, ownerSigningPublicKey: s.identity.signingPublicKey, peerSigningPublicKey: s.other.signingPublicKey };
  await s.state.saveBindings(bundle, pins);
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('No fixture network'));
  return { bundle, pins, fetcher, http: new RoomHttpClient({ hub, fetch: fetcher }) };
}

it('persists scoped keys and exact intents/receipts across reopening, without contacting a hub', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
  const s = await setup(); const before = s.key.publicKey;
  expect(s.state.createRoomKey(s.roomId).publicKey).toBe(before);
  expect(s.state.createRoomKey('room_' + id()).publicKey).not.toBe(before);
  await s.state.retainControl(s.wire); expect(s.state.pending()).toHaveLength(1);
  s.reopen(); expect(s.state.roomKey(s.roomId).publicKey).toBe(before);
  expect(s.state.identity().signingPublicKey).toBe(s.identity.signingPublicKey);
  expect((await s.state.operation('control', s.create.requestId)).wire).toBe(s.wire);
  await s.state.confirmControl(s.wire, s.receipt); await s.state.confirmControl(s.wire, s.receipt);
  s.reopen(); expect(s.state.pending()).toEqual([]);
  expect((await s.state.operation('control', s.create.requestId)).receipt).toEqual(s.receipt);
  expect(fetcher).not.toHaveBeenCalled();
  for (const name of readdirSync(s.directory)) expect(lstatSync(join(s.directory, name)).mode & 0o777).toBe(0o600);
});

it('keeps private scope immutable even if a JavaScript caller adds misleading public fields', async () => {
  const s = await setup(); Object.assign(s.state, { hub: 'https://other.example.com', signingPublicKey: s.other.signingPublicKey });
  s.scope.policy.rooms = 1; // the adapter snapshots policy rather than retaining caller objects
  await s.state.retainControl(s.wire);
  expect(s.state.identity().signingPublicKey).toBe(s.identity.signingPublicKey);
  expect(s.state.createRoomKey('room_' + id()).publicKey).not.toBe(s.key.publicKey);
});

it('reserves session IDs durably, never restores ciphers, and disposes sessions when local state closes', async () => {
  const s = await setup(), a = await accepted(s), sessionId = id();
  await s.state.saveBindings(a.bundle, a.pins); // identical accepted bindings are idempotent
  const first = await s.state.createSession(s.roomId, sessionId, a.http); await first.start();
  const wire = first.pendingWire!; expect(a.fetcher).not.toHaveBeenCalled();
  s.reopen(); expect(first.closed).toBe(true);
  await expect(first.flush()).rejects.toThrow(); expect(a.fetcher).not.toHaveBeenCalled();
  expect((await s.state.operation('packet', JSON.parse(wire).requestId)).wire).toBe(wire);
  await expect(s.state.createSession(s.roomId, sessionId, a.http)).rejects.toThrow(); s.reopen();
  const next = await s.state.createSession(s.roomId, id(), a.http);
  expect(next.ready).toBe(false); expect(next.pendingWire).toBeNull();
  s.state.close(); expect(next.closed).toBe(true);
});

it('rejects substituted accepted bindings and retains the original pins across reopening', async () => {
  const s = await setup(), a = await accepted(s);
  await expect(s.state.saveBindings(a.bundle, { ...a.pins, peerSigningPublicKey: s.identity.signingPublicKey })).rejects.toThrow();
  s.reopen(); const client = await s.state.createSession(s.roomId, id(), a.http);
  expect(client.ready).toBe(false); expect(a.fetcher).not.toHaveBeenCalled();
});

it('bounds retained rooms and session reservations without deleting older keys or reservations', async () => {
  const s = await setup({ rooms: 1, sessions: 1 }), a = await accepted(s);
  expect(() => s.state.createRoomKey('room_' + id())).toThrow(); s.reopen();
  expect(s.state.roomKey(s.roomId)).toEqual(s.key);
  const client = await s.state.createSession(s.roomId, id(), a.http);
  await expect(s.state.createSession(s.roomId, id(), a.http)).rejects.toThrow();
  expect(client.closed).toBe(true); s.reopen();
  await expect(s.state.createSession(s.roomId, id(), a.http)).rejects.toThrow();
  expect(a.fetcher).not.toHaveBeenCalled();
});

it.each(['packets', 'bytes'])('bounds %s before a packet POST while retaining separate close capacity', async variant => {
  const s = await setup(variant === 'packets' ? { packets: 1 } : { packetBytes: 1 }), a = await accepted(s);
  const first = await s.state.createSession(s.roomId, id(), a.http);
  if (variant === 'packets') {
    await first.start(); const wire = first.pendingWire!;
    s.reopen(); const next = await s.state.createSession(s.roomId, id(), a.http);
    await expect(next.start()).rejects.toThrow(); s.reopen();
    expect((await s.state.operation('packet', JSON.parse(wire).requestId)).wire).toBe(wire);
  } else { await expect(first.start()).rejects.toThrow(); s.reopen(); }
  const close: RoomControlAction = { ...s.create, action: 'close', payload: {}, requestId: id(), expectedRevision: 3 };
  await s.state.retainControl(await signRoomControl(close, s.identity.signingPrivateKey));
  expect(s.state.pending()).toHaveLength(variant === 'packets' ? 2 : 1);
  expect(a.fetcher).not.toHaveBeenCalled();
});

it('refuses a corrupt stored signing key and never generates a replacement identity', async () => {
  const s = await setup(); s.state.close();
  const db = new DatabaseSync(join(s.directory, LOCAL_DB_NAME));
  try { db.prepare('UPDATE client_meta SET signing_key=?').run('00'); } finally { db.close(); }
  expect(() => RoomLocalState.open(s.directory, s.scope)).toThrow('Protected room state unavailable');
  const inspect = new DatabaseSync(join(s.directory, LOCAL_DB_NAME));
  try { expect(inspect.prepare('SELECT signing_key FROM client_meta').get()?.signing_key).toBe('00'); } finally { inspect.close(); }
});

it.each(['hub', 'key', 'policy'])('refuses a changed %s binding without replacing retained data', async field => {
  const s = await setup(); s.state.close(); const options = { ...s.scope };
  if (field === 'hub') options.hub = 'https://other.example.com';
  if (field === 'key') options.signingPublicKey = s.other.signingPublicKey;
  if (field === 'policy') options.policy = { ...options.policy, rooms: 11 };
  expect(() => RoomLocalState.open(s.directory, options)).toThrow('Protected room state unavailable');
  s.reopen(); expect(s.state.roomKey(s.roomId).publicKey).toBe(s.key.publicKey);
});

it('refuses reinitialization, missing metadata and unknown directory contents', async () => {
  const s = await setup(); s.state.close();
  expect(() => RoomLocalState.initialize(s.directory, { hub, signingPrivateKey: s.identity.signingPrivateKey, policy: policy() })).toThrow();
  const empty = scratch(); writeFileSync(join(empty, LOCAL_DB_NAME), '', { mode: 0o600 });
  expect(() => RoomLocalState.open(empty, s.scope)).toThrow();
  writeFileSync(join(s.directory, 'unrelated'), 'keep', { mode: 0o600 });
  expect(() => RoomLocalState.open(s.directory, s.scope)).toThrow();
  expect(readdirSync(s.directory)).toContain('unrelated');
});

it.each(['directory mode', 'file mode', 'directory symlink', 'file symlink', 'hardlink', 'repository'])(
  'rejects unsafe %s instead of fixing or following it', async variant => {
    const s = await setup(); s.state.close(); let target = s.directory;
    if (variant === 'directory mode') chmodSync(target, 0o755);
    if (variant === 'file mode') chmodSync(join(target, LOCAL_DB_NAME), 0o644);
    if (variant === 'directory symlink') { target = join(scratch(), 'alias'); symlinkSync(s.directory, target); }
    if (variant === 'file symlink') { target = scratch(); symlinkSync(join(s.directory, LOCAL_DB_NAME), join(target, LOCAL_DB_NAME)); }
    if (variant === 'hardlink') linkSync(join(s.directory, LOCAL_DB_NAME), join(scratch(), 'copy.sqlite'));
    if (variant === 'repository') mkdirSync(join(target, '.git'));
    expect(() => RoomLocalState.open(target, s.scope)).toThrow('Protected room state unavailable');
  });

it('rejects use after permission changes and leaves all existing state intact', async () => {
  const s = await setup(); chmodSync(s.directory, 0o755);
  await expect(s.state.retainControl(s.wire)).rejects.toThrow('Protected room state unavailable');
  chmodSync(s.directory, 0o700); s.reopen(); expect(s.state.pending()).toHaveLength(0);
  expect(s.state.roomKey(s.roomId).publicKey).toBe(s.key.publicKey);
});

it('retains before control POST and keeps uncertain outcomes pending across restarts', async () => {
  const s = await setup(); let posts = 0;
  const http = new RoomHttpClient({ hub, fetch: async () => {
    posts++; expect(s.state.pending()).toHaveLength(1); throw new Error('PRIVATE remote details');
  } });
  await expect(s.state.submitControl(s.wire, http)).rejects.toMatchObject({ code: 'room_transport_unknown' });
  expect(posts).toBe(1); s.reopen(); expect((await s.state.operation('control', s.create.requestId)).wire).toBe(s.wire);
  let lookups = 0;
  const recovery = new RoomHttpClient({ hub, fetch: async (_url, init) => {
    lookups++; const query = JSON.parse(String(init!.body));
    return Response.json({ ok: true, queryId: query.queryId, observedAt: Date.now(), receipt: lookups === 1 ? null : s.receipt });
  } });
  expect(await s.state.recover('control', s.create.requestId, recovery)).toBeNull(); expect(s.state.pending()).toHaveLength(1);
  expect(await s.state.recover('control', s.create.requestId, recovery)).toEqual(s.receipt);
  expect(s.state.pending()).toHaveLength(0); expect(posts).toBe(1);
});

it('rejects mismatched identities, room keys, receipts and request rewrites without partial replacement', async () => {
  const s = await setup(); await s.state.retainControl(s.wire);
  const changed = await signRoomControl({ ...s.create, expiresAt: s.create.expiresAt + 1 }, s.identity.signingPrivateKey);
  await expect(s.state.retainControl(changed)).rejects.toThrow(); s.reopen();
  expect((await s.state.operation('control', s.create.requestId)).wire).toBe(s.wire);
  await expect(s.state.confirmControl(s.wire, { ...s.receipt, revision: 2 })).rejects.toThrow(); s.reopen();
  expect(s.state.pending()).toHaveLength(1);
  await expect(s.state.retainControl(await signRoomControl(s.create, s.other.signingPrivateKey))).rejects.toThrow(); s.reopen();
  const wrongKey = await signRoomControl({ ...s.create, payload: { encryptionPublicKey: s.other.encryptionPublicKey } }, s.identity.signingPrivateKey);
  await expect(s.state.retainControl(wrongKey)).rejects.toThrow(); s.reopen();
  expect((await s.state.operation('control', s.create.requestId)).wire).toBe(s.wire);
});

it('keeps a separate finite close lane at ordinary control capacity and preserves pending work', async () => {
  const s = await setup({ controls: 1 }); await s.state.retainControl(s.wire);
  const extra = { ...s.create, requestId: id() };
  await expect(s.state.retainControl(await signRoomControl(extra, s.identity.signingPrivateKey))).rejects.toThrow(); s.reopen();
  for (let i = 0; i < 4; i++) {
    const close: RoomControlAction = { ...s.create, action: 'close', payload: {}, requestId: id(), expectedRevision: 1 };
    await s.state.retainControl(await signRoomControl(close, s.identity.signingPrivateKey));
  }
  expect(s.state.pending()).toHaveLength(5);
  const another: RoomControlAction = { ...s.create, action: 'close', payload: {}, requestId: id(), expectedRevision: 1 };
  await expect(s.state.retainControl(await signRoomControl(another, s.identity.signingPrivateKey))).rejects.toThrow();
  s.reopen(); expect(s.state.pending()).toHaveLength(5);
});

it.each(['before', 'after'])('preserves atomic intent recovery when COMMIT throws %s its boundary', async phase => {
  const s = await setup(); const original = DatabaseSync.prototype.exec; let armed = true;
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    if (armed && sql === 'COMMIT') { armed = false;
      if (phase === 'after') original.call(this, sql); throw new Error('PRIVATE driver / path'); }
    return original.call(this, sql);
  });
  await expect(s.state.retainControl(s.wire)).rejects.toMatchObject({ message: 'Protected room state unavailable; preserve state and reconcile pending requests' });
  spy.mockRestore(); s.reopen(); expect(s.state.pending()).toHaveLength(phase === 'after' ? 1 : 0);
  if (phase === 'after') expect((await s.state.operation('control', s.create.requestId)).wire).toBe(s.wire);
});

const worker = fileURLToPath(new URL('./fixtures/local-state-worker.mjs', import.meta.url));
function probe(directory: string, scope: unknown): { ok: boolean } {
  return JSON.parse(execFileSync(process.execPath, [worker, 'open', directory, JSON.stringify(scope)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
}
it('keeps exclusive ownership across processes, including after a failed same-process reopen', async () => {
  const s = await setup(); expect(probe(s.directory, s.scope).ok).toBe(false);
  expect(() => RoomLocalState.open(s.directory, s.scope)).toThrow();
  expect(probe(s.directory, s.scope).ok).toBe(false); // no extra FD close destroyed the first connection's locks
  s.state.close(); expect(probe(s.directory, s.scope).ok).toBe(true);
});

function message(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture IPC deadline')); }, 5000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}
it.each(['before', 'after'])('recovers without a stale lock file after process death %s intent retention', async phase => {
  const s = await setup(); s.state.close();
  const child = fork(worker, ['hold', s.directory, JSON.stringify(s.scope)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  cleanup.push(() => { child.kill('SIGKILL'); });
  expect(await message(child)).toEqual({ ready: true });
  const ready = message(child); child.send({ phase, wire: s.wire }); expect(await ready).toEqual({ retained: phase === 'after' });
  expect(probe(s.directory, s.scope).ok).toBe(false);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  s.reopen(); expect(s.state.pending()).toHaveLength(phase === 'after' ? 1 : 0);
  if (phase === 'after') expect((await s.state.operation('control', s.create.requestId)).wire).toBe(s.wire);
});
