import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@openagentforum/protocol';
import { createHookControlHandler, d1HookControlAdmission, HOOK_CONTROL_SCHEMA, type HookControlOptions, type HookControlRef } from '../src/hooks/control.js';
import { sqliteHookControlAdmission } from '../src/hooks/sqlite.js';
import { fixture, HUB } from './hooks-fixture.js';
import { HookError, type HookDispatchJob } from '../src/hooks/types.js';
import type { D1HookDatabase } from '../src/hooks/storage.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export const ENDPOINT = 'https://control.example.net/internal/wake-control';
const token = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const owner = 'agent_0123456789abcdef';
const ref: HookControlRef = { agentId: owner, jobId: crypto.randomUUID(), kind: 'verify' };
const verified = { ok: true, code: 'verified', retryable: false, status: 200 };
const uncertain = { ok: false, code: 'indeterminate', retryable: false };
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });

function request(credential: string, value: unknown = { op: 'poll', after: null }, init: RequestInit = {}, url = ENDPOINT) {
  return new Request(url, { method: 'POST', body: JSON.stringify(value), ...init,
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...init.headers } });
}
async function unit(patch: Partial<HookControlOptions> = {}) {
  const manager = { claim: vi.fn().mockResolvedValue(null), authorizeDispatch: vi.fn().mockResolvedValue(null), complete: vi.fn().mockResolvedValue({ applied: false }) };
  const store = { scanDue: vi.fn().mockResolvedValue([]) };
  const admission = { admit: vi.fn().mockResolvedValue(true) };
  const options = { endpoint: ENDPOINT, hub: HUB, token: token(), manager, store, admission, now: () => 100_000, ...patch };
  const handler = await createHookControlHandler(options);
  const send = (value: unknown, init?: RequestInit) => handler(request(options.token, value, init));
  return { handler, send, options, manager, store, admission };
}

describe('privileged control boundary', () => {
  it.each(['', 'weak', 'x'.repeat(64)])('rejects invalid credential configuration before serving', async bad => {
    await expect(unit({ token: bad })).rejects.toMatchObject({ code: 'invalid_control_config' });
  });
  it.each([
    { endpoint: 'http://control.example.net/internal/wake-control' }, { endpoint: ENDPOINT + '?x' },
    { endpoint: ENDPOINT + '#x' }, { endpoint: ENDPOINT.replace('https://', 'https://user@') },
    { endpoint: ENDPOINT.replace('.net/', '.net:8443/') }, { endpoint: ENDPOINT.replace('control.', 'CONTROL.') },
    { endpoint: 'https://127.0.0.1/internal/wake-control' },
    { hub: HUB + '/' }, { scanLimit: 51 }, { scanLimit: 0 }, { admissionMs: 2001 }, { admission: undefined },
  ])('fails closed on invalid configuration %j', async patch => {
    await expect(unit(patch)).rejects.toMatchObject({ code: 'invalid_control_config' });
  });
  it('authenticates before consuming a body or touching storage; agent signatures do not substitute', async () => {
    const u = await unit();
    for (const authorization of ['', `Bearer ${token()}`, `bearer ${u.options.token}`, `Bearer ${u.options.token}, Bearer ${u.options.token}`]) {
      const r = request(u.options.token, {}, { headers: { authorization, 'x-agent-signature': token() } });
      const read = vi.spyOn(r.body!, 'getReader');
      expect((await u.handler(r)).status).toBe(401);
      expect(read).not.toHaveBeenCalled();
    }
    expect(u.admission.admit).not.toHaveBeenCalled();
    expect(u.store.scanDue).not.toHaveBeenCalled();
  });
  it('rotates by replacing the handler; old token is not a grace credential', async () => {
    const u = await unit();
    const replacement = await createHookControlHandler({ ...u.options, token: token() });
    expect((await replacement(request(u.options.token))).status).toBe(401);
    expect((await u.handler(request(u.options.token))).status).toBe(200);
  });
  it('checks method, exact endpoint and header cap without admission or body reads', async () => {
    const u = await unit();
    expect((await u.handler(new Request(ENDPOINT))).status).toBe(405);
    for (const url of [ENDPOINT + '?x', ENDPOINT.replace('control.', 'other.'), ENDPOINT.replace('wake-control', 'deliver')]) {
      expect((await u.handler(request(u.options.token, {}, {}, url))).status).toBe(404);
    }
    expect((await u.send({}, { headers: { 'x-large': 'x'.repeat(8192) } })).status).toBe(431);
    expect(u.admission.admit).not.toHaveBeenCalled();
  });
  it.each([
    [{ 'content-type': 'text/plain' }, '{}', 400], [{ 'content-encoding': 'gzip' }, '{}', 400],
    [{ 'content-length': 'no' }, '{}', 413], [{ 'content-length': '2049' }, '{}', 413],
    [{}, 'x'.repeat(2049), 413], [{}, '{', 400], [{}, new Uint8Array([0xff]), 400],
  ] as const)('bounds and validates body %j', async (headers, data, status) => {
    const u = await unit();
    const response = await u.send({}, { headers, body: data });
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(u.admission.admit).toHaveBeenCalledTimes(1);
    expect(u.store.scanDue).not.toHaveBeenCalled();
  });
  it('times out and cancels a stalled stream without waiting for its broken cancellation', async () => {
    const u = await unit();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream({ cancel });
    const response = await u.send({}, { body: stream, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(u.store.scanDue).not.toHaveBeenCalled();
  });
  it('bounds even a stream of empty chunks', async () => {
    const u = await unit();
    const response = await u.send({}, { body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); } }), duplex: 'half' } as RequestInit);
    expect(response.status).toBe(413);
  });
  it('does no work on early abort and interrupts an active body', async () => {
    const u = await unit();
    const controller = new AbortController();
    controller.abort();
    expect((await u.send({}, { signal: controller.signal })).status).toBe(408);
    expect(u.admission.admit).not.toHaveBeenCalled();
    const active = new AbortController();
    const stream = new ReadableStream({ pull() { active.abort(); } });
    expect((await u.send({}, { body: stream, signal: active.signal, duplex: 'half' } as RequestInit)).status).toBe(408);
    expect(u.store.scanDue).not.toHaveBeenCalled();
  });
  it.each([
    {}, [], null, { op: 'run', command: 'unused' }, { op: 'poll' }, { op: 'poll', after: false },
    { op: 'poll', after: { dueAt: -1, agentId: owner } }, { op: 'poll', after: null, command: 'unused' },
    { op: 'authorize', ref: { ...ref, jobId: '../' } }, { op: 'authorize', ref: { ...ref, kind: 'command' } },
    { op: 'complete', ref, result: { ...verified, receiverBody: 'unused' } },
    { op: 'complete', ref, result: { ...verified, retryable: true } },
    { op: 'complete', ref, result: { ok: false, code: 'http_error', retryable: false, status: 503 } },
  ])('rejects malformed operation %j without manager access', async input => {
    const u = await unit();
    expect((await u.send(input)).status).toBe(400);
    expect(u.store.scanDue).not.toHaveBeenCalled();
    for (const method of Object.values(u.manager)) expect(method).not.toHaveBeenCalled();
  });
  it('fails closed on admission refusal/error; sanitizes storage errors', async () => {
    const u = await unit();
    u.admission.admit.mockResolvedValue(false);
    const limited = await u.send({ op: 'poll', after: null });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    u.admission.admit.mockRejectedValue(new Error(u.options.token));
    const failed = await u.send({ op: 'poll', after: null });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'control_unavailable' });
    u.admission.admit.mockRejectedValue(new HookError(u.options.token, 400));
    expect(await (await u.send({ op: 'poll', after: null })).json()).toEqual({ error: 'control_unavailable' });
    expect(u.store.scanDue).not.toHaveBeenCalled();
  });
});

describe('bounded advisory polling', () => {
  const rows = [1, 2, 3].map(n => ({ agentId: `agent_${n.toString().padStart(16, '0')}`, dueAt: 99_000 }));
  it('claims at most one job and returns only a reference and last-visited cursor', async () => {
    const u = await unit({ scanLimit: 3 });
    u.store.scanDue.mockResolvedValue(rows);
    u.manager.claim.mockResolvedValueOnce(null).mockResolvedValueOnce({ jobId: ref.jobId, url: 'private', secret: token(), body: { hub: HUB, kind: 'verify', agentId: rows[1].agentId } });
    const response = await u.send({ op: 'poll', after: null });
    expect(await response.json()).toEqual({ ref: { ...ref, agentId: rows[1].agentId }, after: rows[1] });
    expect(u.manager.claim.mock.calls).toEqual([[rows[0].agentId], [rows[1].agentId]]);
    expect(u.store.scanDue).toHaveBeenCalledWith(100_000, 3, null);
  });
  it('advances past unreadable/uncertain owners but never attempts a second claim after a thrown claim', async () => {
    const u = await unit({ scanLimit: 3 });
    u.store.scanDue.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.slice(1));
    u.manager.claim.mockRejectedValueOnce(new Error('possibly committed')).mockResolvedValue(null);
    const first = await (await u.send({ op: 'poll', after: null })).json();
    expect(first).toEqual({ ref: null, after: rows[0] });
    expect(u.manager.claim).toHaveBeenCalledTimes(1);
    expect(await (await u.send({ op: 'poll', after: first.after })).json()).toEqual({ ref: null, after: null });
    expect(u.store.scanDue).toHaveBeenLastCalledWith(100_000, 3, rows[0]);
  });
  it.each([
    [...rows, rows[2]], [rows[1], rows[0]], [rows[0], rows[0]], [{ ...rows[0], dueAt: 100_001 }], [{ ...rows[0], extra: true }],
  ])('rejects a corrupt page before any claim: %j', async page => {
    const u = await unit({ scanLimit: 3 });
    u.store.scanDue.mockResolvedValue(page);
    expect((await u.send({ op: 'poll', after: null })).status).toBe(503);
    expect(u.manager.claim).not.toHaveBeenCalled();
  });
  it('does not admit work after slow storage and does not detach the unfinished query', async () => {
    let monotonic = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const u = await unit({ admissionMs: 10 });
    let finish!: (rows: unknown[]) => void;
    u.store.scanDue.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const response = u.send({ op: 'poll', after: null });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    monotonic = 11;
    finish(rows);
    expect((await response).status).toBe(408);
    expect(u.manager.claim).not.toHaveBeenCalled();
  });
});

function d1(db: DatabaseSync): D1HookDatabase {
  const statement = (sql: string, args: SQLInputValue[] = []): ReturnType<D1HookDatabase['prepare']> => ({
    bind: (...values) => statement(sql, values),
    first: async <T>() => (db.prepare(sql).get(...args) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...args) as T[] }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: sql => statement(sql) };
}

describe.each(['sqlite', 'd1'] as const)('primary control integration (%s)', backend => {
  async function setup() {
    const f = await fixture(backend);
    cleanup.push(f.close);
    f.db.exec(HOOK_CONTROL_SCHEMA);
    const admission = () => backend === 'sqlite' ? sqliteHookControlAdmission(f.db, 16) : d1HookControlAdmission(d1(f.db), 16);
    const credential = token();
    const handler = await createHookControlHandler({ endpoint: ENDPOINT, hub: HUB, token: credential, manager: f.manager, store: f.makeStore(), admission: admission(), now: () => f.clock.now });
    const send = (value: unknown) => handler(request(credential, value));
    const claim = async () => { await f.manager.mutate(await f.setProof()); return (await (await send({ op: 'poll', after: null })).json()).ref as HookControlRef; };
    return { f, send, claim, admission };
  }
  it('shares the admission row across concurrent instances and clock rollback, with bounded storage', async () => {
    const { f, admission } = await setup();
    const gates = [admission(), admission()];
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => gates[i % 2].admit(f.clock.now)));
    expect(results.filter(Boolean)).toHaveLength(16);
    expect(await admission().admit(f.clock.now - 1000)).toBe(false);
    expect(await admission().admit(f.clock.now + 1000)).toBe(true);
    expect(f.db.prepare('SELECT * FROM wake_hook_control_admission').all()).toHaveLength(1);
  });
  it('fails closed when the explicit migration is absent', async () => {
    const { f, send } = await setup();
    f.db.exec('DROP TABLE wake_hook_control_admission');
    expect((await send({ op: 'poll', after: null })).status).toBe(503);
  });
  it('rejects rates outside the hard bounds and shares quota through token rotation/restart', async () => {
    const { f, admission, send } = await setup();
    for (const rate of [0, 17, 1.5, NaN]) {
      expect(() => sqliteHookControlAdmission(f.db, rate)).toThrow();
      expect(() => d1HookControlAdmission(d1(f.db), rate)).toThrow();
    }
    const gate = admission();
    for (let i = 0; i < 16; i++) expect(await gate.admit(f.clock.now)).toBe(true);
    expect((await send({ op: 'poll', after: null })).status).toBe(429);
    await f.restart();
    const nextToken = token();
    const replacement = await createHookControlHandler({ endpoint: ENDPOINT, hub: HUB, token: nextToken, manager: f.manager, store: f.makeStore(), admission: admission(), now: () => f.clock.now });
    expect((await replacement(request(nextToken))).status).toBe(429);
    expect(await admission().admit(f.clock.now)).toBe(false);
  });
  it('overlapping authenticated polls cannot create two claims for the same work', async () => {
    const { f, send } = await setup();
    await f.manager.mutate(await f.setProof());
    const responses = await Promise.all([send({ op: 'poll', after: null }), send({ op: 'poll', after: null })]);
    const values = await Promise.all(responses.map(r => r.json()));
    expect(values.filter(value => value.ref !== null)).toHaveLength(1);
  });
  it('polls no secrets, reauthorizes the matching claim and atomically applies/replays verification', async () => {
    const { f, send, claim } = await setup();
    const ref = await claim();
    expect(Object.keys(ref).sort()).toEqual(['agentId', 'jobId', 'kind']);
    const job = (await (await send({ op: 'authorize', ref })).json()).job as HookDispatchJob;
    expect(job.body.agentId).toBe(f.owner.agentId);
    expect(job.jobId).toBe(ref.jobId);
    const wrong = { ...ref, kind: 'wake' };
    expect(await (await send({ op: 'authorize', ref: wrong })).json()).toEqual({ job: null });
    expect((await send({ op: 'complete', ref: wrong, result: uncertain })).status).toBe(409);
    expect((await f.list()).hooks[0].status).toBe('pending_verification');
    for (let i = 0; i < 2; i++) expect(await (await send({ op: 'complete', ref, result: verified })).json()).toEqual({ ack: ref });
    expect((await f.list()).hooks[0].status).toBe('active');
  });
  it.each(['delete', 'renew', 'expiry', 'membership'])('cancels %s before authorization and acknowledges stale results', async mode => {
    const { f, send } = await setup();
    f.access.set('private', { isPrivate: true, isMember: true });
    const hook = await f.activate(f.spec({ channels: ['private'] }));
    await f.manager.enqueue(f.owner.agentId, await f.message(1, 'private', 'ciphertext', true));
    const { ref } = await (await send({ op: 'poll', after: null })).json();
    f.clock.now++;
    if (mode === 'delete' || mode === 'renew') await f.manager.mutate(await f.proof(mode, hook.hookId));
    else if (mode === 'expiry') f.clock.now += 60_000;
    else f.access.set('private', { isPrivate: true, isMember: false });
    expect(await (await send({ op: 'authorize', ref })).json()).toEqual({ job: null });
    expect(await (await send({ op: 'complete', ref, result: uncertain })).json()).toEqual({ ack: ref });
  });
  it('suppresses a job made stale while authorization was awaiting primary storage', async () => {
    const { f, send, claim } = await setup();
    const ref = await claim();
    const authorize = f.manager.authorizeDispatch.bind(f.manager);
    vi.spyOn(f.manager, 'authorizeDispatch').mockImplementation(async (...args) => {
      const job = await authorize(...args);
      f.clock.now += 60_000;
      return job;
    });
    expect(await (await send({ op: 'authorize', ref })).json()).toEqual({ job: null });
  });
  it.each(['id', 'owner', 'hub', 'hook', 'url', 'future'])('never releases a mismatched authorized %s', async mode => {
    const { f, send, claim } = await setup();
    const ref = await claim();
    const job = (await f.manager.authorizeDispatch(ref.agentId, ref.jobId))!;
    if (mode === 'id') job.jobId = crypto.randomUUID();
    if (mode === 'owner') job.body.agentId = f.sender.agentId;
    if (mode === 'hub') job.body.hub = 'https://other.example.net';
    if (mode === 'hook') job.body.hookId = 'hook_0123456789abcdef';
    if (mode === 'url') job.url = 'http://127.0.0.1/';
    if (mode === 'future') job.body.sentAt = f.clock.now + 1;
    vi.spyOn(f.manager, 'authorizeDispatch').mockResolvedValue(job);
    expect(await (await send({ op: 'authorize', ref })).json()).toEqual({ job: null });
  });
  it('never acknowledges a storage failure, including a lost commit response; replay is safe', async () => {
    const { f, send, claim } = await setup();
    const ref = await claim();
    const complete = f.manager.complete.bind(f.manager);
    const spy = vi.spyOn(f.manager, 'complete').mockRejectedValueOnce(new Error('private storage failure'));
    expect((await send({ op: 'complete', ref, result: verified })).status).toBe(503);
    spy.mockImplementationOnce(async (...args) => { await complete(...args); throw new Error('commit reply lost'); });
    expect((await send({ op: 'complete', ref, result: verified })).status).toBe(503);
    spy.mockRestore();
    expect(await (await send({ op: 'complete', ref, result: verified })).json()).toEqual({ ack: ref });
    expect((await f.list()).hooks[0].status).toBe('active');
    expect(await (await send({ op: 'complete', ref: { ...ref, jobId: crypto.randomUUID() }, result: verified })).json()).toHaveProperty('ack');
  });
});
