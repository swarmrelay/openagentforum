import { afterEach, describe, it, expect, vi } from 'vitest';
import { onRequestPrivateRoom } from '../../../apps/web/functions/_lib/private-room-http.ts';
import { fixture, HUB, actionFor } from './fixtures.ts';
import { TestD1 } from './d1-fixture.ts';
import { initializeD1RoomAdmission } from '../src/d1-admission.ts';
import { initializeD1RoomRequestBudget } from '../src/d1-request-gate.ts';
import { RoomHttpClient, RoomHttpError } from '../src/http-client.ts';
import { ROOM_HTTP_PATHS, ROOM_HTTP_KEY_HEADER, readRoomBody, roomDeadline } from '../src/http-contract.ts';
import { ROOM_PACKET_PROTOCOL, ROOM_PACKET_PROFILE, ROOM_PACKET_READ_PROTOCOL, signRoomPacket, signRoomPacketRead } from '../src/packet-wire.ts';

const limits = () => ({ packets: 1000, bytes: 10000000, sessions: 100, packetsPerWindow: 1000, bytesPerWindow: 10000000, sessionsPerWindow: 100 });
const allowance = () => ({ requests: 100, inputBytes: 1000000, verifications: 1000, responseBytes: 10000000 });
const cleanup = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(f => f()); });
async function setup() {
  const f = await fixture(); cleanup.push(() => f.close());
  const db = new TestD1(f.db);
  const config = { hub: HUB, policy: { ...f.policy }, packets: { hub: limits(), room: limits(), agent: limits(), windowMs: 86400000 },
    requests: { ordinary: allowance(), read: allowance(), close: allowance(), recovery: allowance(), windowMs: 86400000 },
    bodyTimeoutMs: 50, operationTimeoutMs: 2000 };
  await initializeD1RoomAdmission(db, { ...config, now: Date.now });
  await initializeD1RoomRequestBudget(db, { ...config, now: Date.now });
  db.calls = []; db.sessions = [];
  const request = (body = '{}', patch = {}) => new Request(`${HUB}${ROOM_HTTP_PATHS.submit}`, {
    method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json', [ROOM_HTTP_KEY_HEADER]: f.owner.signingPublicKey }, ...patch });
  const run = (req, options = config) => onRequestPrivateRoom(req, db, options);
  const createWire = async () => f.wire(await actionFor(f.owner, 'create', Date.now()));
  const sent = [];
  const fetcher = async (url, init) => { sent.push({ url, ...init }); return run(new Request(url, init)); };
  return { f, db, config, request, run, createWire, sent, client: new RoomHttpClient({ hub: HUB, fetch: fetcher }) };
}

describe('unmounted Pages room HTTP boundary', () => {
  it('fails closed without operator config or binding and never initializes storage', async () => {
    const t = await setup();
    expect((await onRequestPrivateRoom(t.request(), t.db)).status).toBe(503);
    expect((await onRequestPrivateRoom(t.request(), undefined, t.config)).status).toBe(503);
    expect(t.db.calls).toEqual([]);
    t.f.db.exec('DELETE FROM room_lab_request_budget');
    expect((await t.run(t.request(await t.createWire()))).status).toBe(503);
    expect(t.f.db.prepare('SELECT count(*) AS n FROM room_lab_request_budget').get().n).toBe(0);
  });
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) it(`does not read or mutate on ${method}`, async () => {
    const t = await setup();
    const r = await t.run(t.request(null, { method }));
    expect(r.status).toBe(405); expect(r.headers.get('allow')).toBe('POST'); expect(t.db.calls).toEqual([]);
  });
  it('requires a pinned HTTPS origin and exact route, without Host or forwarded-host fallbacks', async () => {
    const t = await setup();
    for (const url of ['https://elsewhere.example/v1/rooms/control', `${HUB}/v1/rooms/control?roomId=secret`, `${HUB}/v1/rooms/control/`]) {
      const r = await t.run(new Request(url, { method: 'POST', body: '{}', headers: { host: 'relay.example.com', 'x-forwarded-host': 'relay.example.com' } }));
      expect(r.status).toBe(404);
    }
    expect((await t.run(t.request(), { ...t.config, hub: 'http://relay.example.com' })).status).toBe(503);
    expect(t.db.calls).toEqual([]);
  });
  it('rejects cross-origin requests and unsupported media before reading a body', async () => {
    const t = await setup();
    for (const extra of [{ origin: 'https://attacker.example' }, { origin: 'null' }, { 'content-type': 'text/plain' },
      { 'content-type': 'application/json; charset=iso-8859-1' }, { 'content-encoding': 'gzip' }]) {
      const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } });
      const r = await t.run(t.request(stream, { headers: { 'content-type': 'application/json', [ROOM_HTTP_KEY_HEADER]: t.f.owner.signingPublicKey, ...extra } }));
      expect([403, 415]).toContain(r.status);
    }
    expect(t.db.calls).toEqual([]);
  });
  it('enforces raw bytes despite absent or dishonest Content-Length, and rejects malformed UTF-8', async () => {
    const t = await setup();
    for (const body of ['x'.repeat(4097), 'é'.repeat(2049)]) {
      const r = await t.run(t.request(body, { headers: { 'content-type': 'application/json', [ROOM_HTTP_KEY_HEADER]: t.f.owner.signingPublicKey, 'content-length': '1' } }));
      expect(r.status).toBe(413);
    }
    expect((await t.run(t.request(new Uint8Array([0xc3, 0x28])))).status).toBe(400);
    expect(t.db.calls).toEqual([]);
  });
  it('preserves exact signed bytes and rejects BOM/whitespace instead of repairing proofs', async () => {
    const t = await setup(), wire = await t.createWire();
    for (const body of ['\ufeff' + wire, wire + '\n', wire.replace('"action":', '"action" :')]) {
      expect((await t.run(t.request(body))).status).toBe(409);
    }
    expect(t.f.counts().rooms).toBe(0);
    const r = await t.run(t.request(wire)); expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(t.f.counts().rooms).toBe(1);
  });
  it('times out a stalled body and cancellation without starting D1 work', async () => {
    const t = await setup(); let canceled = false;
    const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; return new Promise(() => {}); } });
    expect((await t.run(t.request(stream))).status).toBe(408); expect(canceled).toBe(true); expect(t.db.calls).toEqual([]);
  });
  it('bounds endless empty-chunk work independently of timer progress', async () => {
    const deadline = roomDeadline(1000);
    try { await expect(readRoomBody(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(0)); } }), 4096, deadline.signal)).rejects.toMatchObject({ code: 'limit' }); }
    finally { deadline.close(); }
  });
  it('a late budget acknowledgment spends the charge but never starts protected work', async () => {
    const t = await setup(), wire = await t.createWire();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.db.afterCommit = () => held;
    const r = await t.run(t.request(wire), { ...t.config, operationTimeoutMs: 20 });
    expect(r.status).toBe(503); expect(await r.json()).toEqual({ ok: false, error: 'room_outcome_unknown' });
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(t.f.counts().rooms).toBe(0);
    expect(t.db.calls.every(sql => sql.includes('room_lab_request_budget'))).toBe(true);
    expect(JSON.parse(t.f.db.prepare('SELECT state_json FROM room_lab_request_budget').get().state_json).lanes.ordinary.requests).toBe(1);
  });
  it('a lost mutation acknowledgment is generic and an exact retry recovers once', async () => {
    const t = await setup(), wire = await t.createWire(); let commits = 0;
    t.db.afterCommit = async () => { if (++commits === 2) throw new Error('PRIVATE_SQL_PACKET_KEY_MARKER'); };
    await expect(t.client.submit(wire, t.f.owner.signingPublicKey)).rejects.toMatchObject({ status: 503, code: 'room_outcome_unknown' });
    expect(t.f.counts().rooms).toBe(1);
    t.db.afterCommit = async () => {};
    expect((await t.client.submit(wire, t.f.owner.signingPublicKey)).replayed).toBe(true);
    expect(t.f.counts().rooms).toBe(1); expect(t.f.counts().receipts).toBe(1);
  });
  it('late mutation completion remains uncertain and neither refunds nor creates replacement work', async () => {
    const t = await setup(), wire = await t.createWire(); let commits = 0, release;
    const held = new Promise(resolve => { release = resolve; });
    t.db.afterCommit = async () => { if (++commits === 2) await held; };
    const response = await t.run(t.request(wire), { ...t.config, operationTimeoutMs: 25 });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, error: 'room_outcome_unknown' });
    expect(t.f.counts().rooms).toBe(1); release(); await new Promise(resolve => setTimeout(resolve, 5));
    t.db.afterCommit = async () => {};
    expect((await t.client.submit(wire, t.f.owner.signingPublicKey)).replayed).toBe(true);
    expect(t.f.counts().receipts).toBe(1);
  });
  it('surfaces shared saturation with Retry-After and no verification or automatic retry', async () => {
    const t = await setup();
    const retained = JSON.parse(t.f.db.prepare('SELECT state_json FROM room_lab_request_budget').get().state_json);
    const first = await t.client.submit(await t.createWire(), t.f.owner.signingPublicKey); expect(first.ok).toBe(true);
    const row = t.f.db.prepare('SELECT state_json FROM room_lab_request_budget').get();
    const state = JSON.parse(row.state_json); state.lanes.ordinary.requests = t.config.requests.ordinary.requests;
    const { canonicalizeJson } = await import('@openagentforum/protocol');
    t.f.db.prepare('UPDATE room_lab_request_budget SET state_json = ?').run(canonicalizeJson(state));
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const wire = await t.createWire(); const before = verify.mock.calls.length;
    await expect(t.client.submit(wire, t.f.owner.signingPublicKey)).rejects.toMatchObject({ status: 429, code: 'room_rate_limited', permitsReplacementMutation: false });
    expect(verify.mock.calls.length).toBe(before); expect(t.sent).toHaveLength(2);
    expect(retained.lanes.ordinary.requests).toBe(0);
  });
});

describe('one-attempt HTTP client', () => {
  it('pins destination, omits credentials, refuses redirects and transmits unchanged wires', async () => {
    const t = await setup(), wire = await t.createWire();
    expect((await t.client.submit(wire, t.f.owner.signingPublicKey)).ok).toBe(true);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ url: `${HUB}/v1/rooms/control`, body: wire, method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    await expect(t.client.submit(wire.replace(HUB, 'https://attacker.example'), t.f.owner.signingPublicKey)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(t.sent).toHaveLength(1);
  });
  for (const scenario of ['network', 'redirect', 'huge', 'invalid-json', 'stalled']) it(`redacts ${scenario} failures and never retries`, async () => {
    const t = await setup(); let calls = 0;
    const client = new RoomHttpClient({ hub: HUB, timeoutMs: 20, fetch: async () => {
      calls++;
      if (scenario === 'network') throw new Error('PRIVATE_REMOTE_MARKER');
      if (scenario === 'stalled') return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } });
      if (scenario === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://attacker.example' } });
      return new Response(scenario === 'huge' ? 'x'.repeat(4097) : 'PRIVATE_REMOTE_MARKER', { headers: { 'content-type': 'application/json' } });
    } });
    const error = await client.submit(await t.createWire(), t.f.owner.signingPublicKey).catch(e => e);
    expect(error).toBeInstanceOf(RoomHttpError); expect(String(error)).not.toContain('PRIVATE_REMOTE_MARKER'); expect(calls).toBe(1);
  });
  it('rejects uncorrelated success rather than treating it as an acknowledgment', async () => {
    const t = await setup(), firstWire = await t.createWire();
    const result = await t.client.submit(firstWire, t.f.owner.signingPublicKey);
    const client = new RoomHttpClient({ hub: HUB, fetch: async () => Response.json(result) });
    await expect(client.submit(await t.createWire(), t.f.owner.signingPublicKey)).rejects.toMatchObject({ code: 'room_invalid_response', permitsReplacementMutation: false });
  });
  for (const fault of ['query', 'cursor', 'duplicate', 'room', 'revision', 'signature', 'expired']) it(`rejects ${fault} in a read response before returning a page`, async () => {
    const t = await setup(), key = t.f.peer, time = Date.now(), roomId = 'room_' + '1'.repeat(32);
    const wire = await signRoomPacket({ protocol: ROOM_PACKET_PROTOCOL, hub: HUB, roomId: fault === 'room' ? 'room_' + '2'.repeat(32) : roomId,
      actor: key.agentId, signingPublicKey: key.signingPublicKey, requestId: '1'.repeat(32), issuedAt: time, expiresAt: time + 60000,
      expectedRevision: fault === 'revision' ? 4 : 3, profile: ROOM_PACKET_PROFILE, sessionId: '1'.repeat(32), packetIndex: 0,
      kind: 'handshake', packetHex: 'ab'.repeat(48) }, key.signingPrivateKey);
    const query = { protocol: ROOM_PACKET_READ_PROTOCOL, hub: HUB, roomId, actor: key.agentId, signingPublicKey: key.signingPublicKey,
      queryId: '2'.repeat(32), expectedRevision: 3, afterStoredSeq: 0, limit: 8, issuedAt: time - 1000, expiresAt: fault === 'expired' ? time - 1 : time + 59000 };
    const records = [{ storedSeq: 1, wire: fault === 'signature' ? wire.replace(/"signature":"[0-9a-f]+"/, '"signature":"' + '0'.repeat(128) + '"') : wire }];
    if (fault === 'duplicate') records.push({ ...records[0], storedSeq: 2 });
    const client = new RoomHttpClient({ hub: HUB, fetch: async () => Response.json({ ok: true, queryId: fault === 'query' ? '3'.repeat(32) : query.queryId,
      observedAt: time, page: { records, nextStoredSeq: fault === 'cursor' ? 99 : records.at(-1).storedSeq } }) });
    await expect(client.readPackets(await signRoomPacketRead(query, key.signingPrivateKey))).rejects.toMatchObject({ code: 'room_invalid_response' });
  });
});
