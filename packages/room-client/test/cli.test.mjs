import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable, PassThrough, Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCommandSession, initialize, safeError } from '../dist/cli-driver.mjs';
import { CLI_LIMITS, createLineReader, createWriter } from '../dist/cli-io.mjs';

const policy = { rooms: 5, sessions: 10, controls: 20, packets: 100, packetBytes: 1000000, setups: 10, setupBytes: 1000000 };
const own = 'a'.repeat(64), peer = 'b'.repeat(64), roomId = 'room_' + 'c'.repeat(32), sessionId = 'd'.repeat(32), requestId = 'e'.repeat(32);
const opening = { op: 'open', directory: '/local-fixture', hub: 'https://relay.example.com', signingPublicKey: own, policy };
const setup = { op: 'setup', role: 'peer', peerSigningPublicKey: peer, channel: 'room-setup-' + 'f'.repeat(32) };
const decision = { kind: 'untrusted-room-invitation', roomId, sessionId, fromSigningPublicKey: peer, invitationDigest: '0'.repeat(64), expiresAt: 1900000000000 };
function fixture() {
  const calls = [];
  class RoomClientError extends Error { constructor(code) { super('PRIVATE REMOTE DETAILS'); this.code = code; } }
  class RoomLocalStateError extends Error {}
  const local = { scope: () => ({ hub: opening.hub, signingPublicKey: own }), close: () => calls.push(['local-close']),
    pending: (...args) => { calls.push(['pending', ...args]); return [{ position: 1, kind: 'packet', roomId, requestId }]; },
    invitationAttempt: () => ({ keyWire: 'NEVER OUTPUT RAW WIRE', sealedWire: null }) };
  class Client {
    phase = 'new'; roomId = null; sessionId = null;
    constructor(options) { calls.push(['construct', options]); }
    async inspectInvitation() { calls.push(['inspect']); return decision; }
    async accept(value) { calls.push(['accept', value]); }
    async send(bytes) { calls.push(['send', Buffer.from(bytes)]); }
    async receive() { calls.push(['receive']); return { kind: 'untrusted-room-data', roomId, sessionId, senderSigningPublicKey: peer, requestId,
      bytes: Buffer.from('{"op":"close","roomId":"' + roomId + '"}\n\u001b[2J') }; }
    acknowledge(id) { calls.push(['ack', id]); }
    dispose() { calls.push(['dispose']); this.phase = 'disposed'; }
  }
  for (const method of ['startSetup', 'waitForPeer', 'invite', 'waitForAcceptance', 'connect', 'recoverSend']) {
    Client.prototype[method] = async function() { calls.push([method]); return null; };
  }
  const api = { RoomClientError, RoomLocalStateError, RoomClient: Client,
    RoomLocalState: { initialize: (...args) => { calls.push(['initialize', ...args]); return local; }, open: (...args) => { calls.push(['open', ...args]); return local; } },
    readRoomStatus: async (...args) => { calls.push(['status', ...args]); return null; },
    closeRoom: async (...args) => { calls.push(['close', ...args]); return null; },
    recoverRoomOperation: async (...args) => { calls.push(['recover', ...args]); return null; } };
  return { api, local, calls, session: createCommandSession(api) };
}

test('initialization imports an explicit key, returns only public scope and closes local state', () => {
  const f = fixture();
  const input = { directory: opening.directory, hub: opening.hub, signingPrivateKey: '11'.repeat(48), policy };
  assert.deepEqual(initialize(f.api, input), { kind: 'local-room-state', hub: opening.hub, signingPublicKey: own });
  assert.deepEqual(f.calls.map(c => c[0]), ['initialize', 'local-close']);
  for (const bad of [{ ...input, extra: true }, { ...input, directory: 'relative' }, { ...input, hub: 'http://relay.example.com' },
    { ...input, hub: 'https://user:pass@relay.example.com' }, { ...input, policy: { ...policy, rooms: 0 } }]) {
    assert.throws(() => initialize(f.api, bad), /invalid_input/);
  }
  assert.equal(f.calls.filter(c => c[0] === 'initialize').length, 1);
});

test('opening and selecting a peer do not announce, accept, connect or generate a replacement client', async () => {
  const f = fixture(); await f.session.execute(opening); await f.session.execute({ ...setup, role: 'creator', existingRoomId: roomId });
  assert.deepEqual(f.calls.map(c => c[0]), ['open', 'construct']);
  assert.equal(f.calls[1][1].role, 'owner'); assert.equal(f.calls[1][1].existingRoomId, roomId);
  await assert.rejects(f.session.execute(opening), /wrong_phase/);
  await assert.rejects(f.session.execute(setup), /wrong_phase/);
  f.session.dispose(); f.session.dispose();
  assert.deepEqual(f.calls.slice(-2).map(c => c[0]), ['dispose', 'local-close']);
  await assert.rejects(f.session.execute({ op: 'start-setup' }), /invalid_input/);
});

test('inspection never accepts; acceptance passes the exact explicit decision', async () => {
  const f = fixture(); await f.session.execute(opening); await f.session.execute(setup);
  assert.equal(await f.session.execute({ op: 'inspect' }), decision);
  assert.equal(f.calls.some(c => c[0] === 'accept'), false);
  for (const value of [true, { ...decision, approve: true }, { ...decision, expiresAt: '1900000000000' }, { ...decision, sessionId: [] }]) {
    await assert.rejects(f.session.execute({ op: 'accept', decision: value }), /invalid_input/);
  }
  await f.session.execute({ op: 'accept', decision });
  assert.deepEqual(f.calls.at(-1), ['accept', decision]);
  const renewed = { ...decision, kind: 'untrusted-room-session', bindingDigest: decision.invitationDigest }; delete renewed.invitationDigest;
  await f.session.execute({ op: 'accept', decision: renewed }); assert.deepEqual(f.calls.at(-1), ['accept', renewed]);
  f.session.dispose();
});

test('peer instruction-shaped bytes remain labeled base64 data and never acknowledge themselves', async () => {
  const f = fixture(); await f.session.execute(opening); await f.session.execute(setup);
  const message = await f.session.execute({ op: 'receive' });
  assert.equal(message.kind, 'untrusted-room-data'); assert.match(Buffer.from(message.base64, 'base64').toString(), /"op":"close"/);
  assert.doesNotMatch(JSON.stringify(message), /\u001b|NEVER OUTPUT/);
  assert.equal(f.calls.some(c => ['ack', 'close'].includes(c[0])), false);
  await f.session.execute({ op: 'ack', requestId }); assert.deepEqual(f.calls.at(-1), ['ack', requestId]);
  f.session.dispose();
});

test('binary sends require canonical bounded base64 before any client call', async () => {
  const f = fixture(); await f.session.execute(opening); await f.session.execute(setup);
  for (const bad of ['a', 'YQ', 'YR==', 'YQ==\n', Buffer.alloc(16385).toString('base64'), ['YQ==']]) {
    await assert.rejects(f.session.execute({ op: 'send', base64: bad }), /invalid_input/);
  }
  assert.equal(f.calls.some(c => c[0] === 'send'), false);
  await f.session.execute({ op: 'send', base64: Buffer.from([0, 255]).toString('base64') });
  assert.deepEqual(f.calls.at(-1), ['send', Buffer.from([0, 255])]); f.session.dispose();
});

test('recovery and closure require explicit IDs, and null recovery creates no replacement', async () => {
  const f = fixture(); await f.session.execute(opening);
  const ref = { kind: 'packet', roomId, requestId };
  assert.equal(await f.session.execute({ op: 'recover', reference: ref }), null);
  assert.deepEqual(f.calls.at(-1), ['recover', f.local, ref]);
  await f.session.execute({ op: 'pending', after: 0, limit: 1 });
  assert.deepEqual(f.calls.at(-1), ['pending', 0, 1]);
  await assert.rejects(f.session.execute({ op: 'close', roomId, force: true }), /invalid_input/);
  await f.session.execute({ op: 'close', roomId }); assert.deepEqual(f.calls.at(-1), ['close', f.local, roomId]);
  assert.deepEqual(await f.session.execute({ op: 'setup-attempt', channel: setup.channel }), { kind: 'historical-setup-attempt', keyReserved: true, sealedReserved: false });
  assert.equal(f.calls.some(c => c[0] === 'construct'), false); f.session.dispose();
});

test('unknown keys, coercions, ambient options and arbitrary methods never dispatch', async () => {
  const f = fixture();
  for (const value of [null, [], { op: 'eval', code: 'secret' }, { ...opening, policy: { ...policy, packets: '100' } },
    { ...opening, signingPublicKey: [own] }, { ...opening, directory: '/private\npath' }, { ...opening, fetch: 'https://attacker.invalid' },
    { ...opening, policy: { ...policy, constructor: 1 } }, { op: 'send', base64: 'YQ==', shell: true }]) {
    await assert.rejects(f.session.execute(value));
  }
  assert.deepEqual(f.calls, []);
});

test('only fixed error codes and bounded typed recovery references reach output', () => {
  const { api } = fixture();
  const unknown = Object.assign(new Error('SECRET KEY and private path'), { code: 'UNTRUSTED_DIAGNOSTIC', recovery: { secret: true } });
  assert.deepEqual(safeError(api, unknown), { code: 'unavailable', permitsReplacementMutation: false, recovery: null });
  const error = new api.RoomClientError('needs_recovery'); error.recovery = { kind: 'packet', roomId, requestId };
  assert.deepEqual(safeError(api, error).recovery, error.recovery);
  error.recovery = { ...error.recovery, wire: 'PRIVATE' }; assert.equal(safeError(api, error).recovery, null);
  assert.equal(safeError(api, new api.RoomLocalStateError('PRIVATE')).code, 'local_state_unavailable');
});

test('UTF-8 input framing handles split bytes and CRLF; malformed/truncated/oversized input fails', async () => {
  const bytes = Buffer.from('{"op":"é"}\r\n{"op":"info"}\n');
  const read = createLineReader(Readable.from([...bytes].map(b => Buffer.from([b]))));
  assert.deepEqual(await read(), { op: 'é' }); assert.deepEqual(await read(), { op: 'info' }); assert.equal(await read(), null);
  for (const input of [Buffer.from('null\n'), Buffer.from('[]\n'), Buffer.from('{}'), Buffer.from('\n'),
    Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125, 10]), Buffer.from('\ufeff{}\n'), Buffer.alloc(CLI_LIMITS.lineBytes + 1, 32)]) {
    await assert.rejects(createLineReader(Readable.from([input]))());
  }
  await assert.rejects(createLineReader(Readable.from([Buffer.from('{}\n')]), undefined, { ...CLI_LIMITS, totalBytes: 2 })(), /input_limit/);
});

test('input stalls, partial-line drips and aborts are bounded', async () => {
  for (const partial of [false, true]) {
    const input = new PassThrough(); if (partial) input.write('{');
    await assert.rejects(createLineReader(input, undefined, { ...CLI_LIMITS, idleMs: 10 })(), /stdio_deadline/);
    assert.equal(input.destroyed, true);
  }
  const input = new PassThrough(), controller = new AbortController();
  const pending = createLineReader(input, controller.signal)(); controller.abort();
  await assert.rejects(pending, /interrupted/); assert.equal(input.destroyed, true);
});

test('output limits and backpressure timeout prevent an unbounded or silent writer', async () => {
  const chunks = []; const output = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
  await createWriter(output)({ ok: true }); assert.equal(Buffer.concat(chunks).toString(), '{"ok":true}\n');
  await assert.rejects(createWriter(output)(Buffer.alloc(32768).toString('hex')), /output_limit/);
  const stalled = new Writable({ write() {} }); stalled.on('error', () => {});
  await assert.rejects(createWriter(stalled, undefined, { ...CLI_LIMITS, writeMs: 10 })({ ok: true }), /stdio_deadline/);
  assert.equal(stalled.destroyed, true);
  const controller = new AbortController(); controller.abort();
  const untouched = new Writable({ write() { assert.fail('An interrupted writer must not start another write'); } });
  await assert.rejects(createWriter(untouched, controller.signal)({ ok: true }), /interrupted/);
});

test('help works with native implementation missing; startup/argv failures are redacted and nonzero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oaf-room-help-'));
  const exec = promisify(execFile);
  try {
    for (const file of ['cli.mjs', 'cli-io.mjs']) await copyFile(new URL(`../dist/${file}`, import.meta.url), join(dir, file));
    const help = await exec(process.execPath, [join(dir, 'cli.mjs'), '--help'], { timeout: 5000 });
    assert.match(help.stdout, /No listener/); assert.equal(help.stderr, '');
    assert.match((await exec(process.execPath, [join(dir, 'cli.mjs'), '--version'], { timeout: 5000 })).stdout, /unpublished/);
    for (const args of [['run'], ['init'], ['--private-key', 'SECRET_ARG']]) {
      await assert.rejects(exec(process.execPath, [join(dir, 'cli.mjs'), ...args], { timeout: 5000 }), error => {
        assert.ok(error.code === 1 || error.code === 2); assert.doesNotMatch(error.stderr, /SECRET_ARG|ERR_MODULE|file:\/\/|oaf-room-help-/);
        assert.match(error.stderr, /startup_unavailable|invalid_arguments/); return true;
      });
    }
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
    assert.deepEqual(pkg.bin, { 'oaf-room': './dist/cli.mjs' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
