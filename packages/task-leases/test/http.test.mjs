import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TaskLeaseHttpClient, JournaledTaskLeaseClient } from '../dist/http-client.js';
import { createTaskLeaseHttpHandler } from '../dist/http-server.js';
import { path, proofRoute, readBody, deadline } from '../dist/http-contract.js';
import { LIMITS, verifyWire } from '../dist/contract.js';
import { sqlite, creation, signed, recovery, business } from './helpers.mjs';

const request = (f, pathname, body, init = {}) => new Request(f.options.origin + pathname, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half', ...init,
});
const handler = (f, extra = {}, store = f.store()) => createTaskLeaseHttpHandler(store, { ...f.options, bodyTimeoutMs: 1000, ...extra });
const client = (f, serve, actor = f.actors[0], extra = {}) => new TaskLeaseHttpClient({ ...f.options, actorKey: actor.signingPublicKey,
  fetch: async (url, init) => serve(new Request(url, init)), ...extra });
const location = async wire => path(proofRoute(await verifyWire(wire)));

test('HTTP clients preserve full signed operations, historical retries and fresh receipt recovery', async t => {
  const f = await sqlite(t), serve = handler(f), owner = client(f, serve), worker = client(f, serve, f.actors[1]);
  const wire = await creation(f), created = await owner.write(wire);
  assert.equal(created.receipt.action, 'create'); assert.equal(created.replayed, false);
  assert.deepEqual((await owner.write(wire)).receipt, created.receipt);
  const task = await f.read(created.receipt.taskId), claim = await signed(f, f.actors[1], 'claim', task);
  const claimed = await worker.write(claim);
  const submit = await signed(f, f.actors[1], 'submit', await f.read(task.taskId), { generation: claimed.receipt.generation, resultPayload: { done: true } });
  assert.equal((await worker.write(submit)).receipt.status, 'completed');
  assert.deepEqual((await worker.recover(claim, await recovery(f, claim))).receipt, claimed.receipt);
  await assert.rejects(worker.write(claim.replace('"claim"', '"reopen"')), { code: 'invalid_request' });
  await assert.rejects(owner.recover(wire, await recovery(f, claim)), { code: 'invalid_request' });
});

test('trusted paths bind action and full task ID after charging and never accept legacy paths or proofs', async t => {
  const f = await sqlite(t), serve = handler(f), created = await f.create(), wire = await signed(f, f.actors[1], 'claim', created);
  const before = business(await f.inspect());
  for (const pathname of [`/v1/task-leases/${'task_' + 'ff'.repeat(32)}/claim`, `/v1/task-leases/${created.taskId}/release`]) {
    const response = await serve(request(f, pathname, wire)); assert.equal(response.status, 400);
  }
  const state = await f.inspect(), attempts = JSON.parse(state.task_lease_authority[0].attempts_json);
  assert.equal(attempts.ordinary, 2); assert.equal(attempts.completion, 1);
  assert.deepEqual(business(state), before);
  for (const pathname of ['/v1/tasks', `/v1/tasks/${created.taskId}/claim`, '/v1/task-leases/', '/v1/task-leases?ordinary=completion']) {
    assert.equal((await serve(request(f, pathname, wire))).status, 404);
  }
  assert.equal((await serve(request(f, '/v1/task-leases', JSON.stringify({ agentId: 'legacy', signature: '00' })))).status, 400);
  assert.deepEqual(business(await f.inspect()), before);
});

test('GET and HEAD observe expired leases without charging, claiming or expiring business state', async t => {
  const f = await sqlite(t), task = await f.create(), claimed = await f.claim(task); await f.age(task.taskId);
  const serve = handler(f), before = await f.inspect();
  const response = await serve(new Request(f.options.origin + `/v1/task-leases/${task.taskId}`));
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
  const value = await response.json(); assert.equal(value.task.leaseState, 'expired');
  assert.equal(value.task.reconciliationRequired, true); assert.equal(value.task.generation, claimed.generation);
  assert(!Object.hasOwn(value.task, 'result')); assert(!Object.hasOwn(value.task, 'receipts'));
  const head = await serve(new Request(f.options.origin + `/v1/task-leases/${task.taskId}`, { method: 'HEAD' }));
  assert.equal(await head.text(), ''); assert.deepEqual(await f.inspect(), before);
  assert.equal((await serve(new Request(f.options.origin + '/v1/task-leases'))).status, 405);
});

test('body byte, UTF-8, read and time bounds retain their charge without mutation', async t => {
  const f = await sqlite(t), serve = handler(f, { bodyTimeoutMs: 30 });
  for (const [body, expected] of [[new Uint8Array(LIMITS.wireBytes + 1), 413], [new Uint8Array([0xff]), 400], ['{', 400]]) {
    const response = await serve(request(f, '/v1/task-leases', body)); assert.equal(response.status, expected);
  }
  const stalled = new ReadableStream({ pull() {} }, { highWaterMark: 0 });
  assert.equal((await serve(request(f, '/v1/task-leases', stalled))).status, 408);
  const excessiveReads = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); } }, { highWaterMark: 0 });
  assert.equal((await serve(request(f, '/v1/task-leases', excessiveReads))).status, 413);
  const state = await f.inspect(); assert.equal(state.task_lease_tasks.length, 0);
  assert.equal(JSON.parse(state.task_lease_authority[0].attempts_json).ordinary, 5);
});

test('exhausted lanes and invalid request headers refuse without pulling bodies; completion remains separate', async t => {
  const f = await sqlite(t, { attempts: { ordinary: 2, completion: 1, recovery: 1 } });
  const task = await f.create(), claimed = await f.claim(task); let pulls = 0;
  const serve = handler(f), body = () => new ReadableStream({ pull(controller) { pulls++; controller.close(); } }, { highWaterMark: 0 });
  const limited = await serve(request(f, '/v1/task-leases', body()));
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '86400'); assert.equal(pulls, 0);
  const done = await signed(f, f.actors[1], 'submit', claimed, { generation: claimed.generation, resultPayload: null });
  assert.equal((await serve(request(f, await location(done), done))).status, 200);
  const before = await f.inspect();
  for (const headers of [{ origin: 'https://outsider.invalid', 'content-type': 'application/json' },
    { 'content-type': 'text/plain' }, { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    { 'content-type': 'application/json', 'content-length': String(LIMITS.wireBytes + 1) }]) {
    assert((await serve(request(f, '/v1/task-leases', body(), { headers }))).status >= 400);
  }
  assert.equal(pulls, 0); assert.deepEqual(await f.inspect(), before);
});

test('journal retention precedes dispatch, failures prevent sends and lost acknowledgments remain pending', async t => {
  const f = await sqlite(t), serve = handler(f), wire = await creation(f); let retained, acknowledged, sends = 0, lose = true;
  const transport = client(f, async request => {
    assert.equal(retained.wire, wire); sends++;
    const response = await serve(request); if (lose) throw new Error('fixture lost response'); return response;
  });
  const journal = { async retain(value) { retained = structuredClone(value); }, async acknowledge(_, receipt) { acknowledged = receipt; } };
  const broken = new JournaledTaskLeaseClient(transport, { ...journal, async retain() { throw new Error('durability failed'); } });
  await assert.rejects(broken.write(wire), /durability failed/); assert.equal(sends, 0);
  const first = new JournaledTaskLeaseClient(transport, journal);
  await assert.rejects(first.write(wire), { code: 'task_transport_unknown', permitsReplacementMutation: false });
  assert.equal(sends, 1); assert.equal(acknowledged, undefined); assert.equal((await f.inspect()).task_lease_tasks.length, 1);
  lose = false;
  const reopened = new JournaledTaskLeaseClient(client(f, serve), journal);
  const result = await reopened.recover(retained.wire, await recovery(f, retained.wire));
  assert.deepEqual(acknowledged, result.receipt); assert.equal((await f.inspect()).task_lease_tasks.length, 1);
  const unacknowledged = new JournaledTaskLeaseClient(client(f, serve), { ...journal, async acknowledge() { throw new Error('ack failed'); } });
  await assert.rejects(unacknowledged.recover(wire, await recovery(f, wire)), /ack failed/);
});

test('client refuses mismatched scope/receipts, redirects, oversize or stalled replies with no automatic retry', async t => {
  const f = await sqlite(t), serve = handler(f), wire = await creation(f);
  const original = await (await serve(request(f, '/v1/task-leases', wire))).json();
  const variants = [value => { value.scope.generation = '00'.repeat(32); }, value => { value.receipt.commandDigest = '00'.repeat(32); },
    value => { value.receipt.actorKey = f.actors[1].signingPublicKey; }, value => { value.receipt.revision++; },
    value => { value.receipt.action = 'claim'; }, value => { value.scope.extra = true; }];
  for (const mutate of variants) {
    const value = structuredClone(original); mutate(value); let calls = 0;
    const c = client(f, () => { calls++; return Response.json(value); });
    await assert.rejects(c.write(wire), { code: 'task_invalid_response', permitsReplacementMutation: false }); assert.equal(calls, 1);
  }
  for (const reply of [() => new Response('x'.repeat(32769), { headers: { 'content-type': 'application/json' } }),
    () => new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }),
    () => { const r = Response.json(original); Object.defineProperty(r, 'redirected', { value: true }); return r; }]) {
    let calls = 0; const c = client(f, () => { calls++; return reply(); }, f.actors[0], { timeoutMs: 20 });
    await assert.rejects(c.write(wire), error => error.permitsReplacementMutation === false && !error.message.includes('fixture'));
    assert.equal(calls, 1);
  }
});

test('unavailable receipt recovery remains historical and pending; concurrent client calls fail closed', async t => {
  const f = await sqlite(t), serve = handler(f), wire = await creation(f); let ack = 0, retained = 0;
  const c = new JournaledTaskLeaseClient(client(f, serve), { async retain() { retained++; }, async acknowledge() { ack++; } });
  assert.deepEqual(await c.recover(wire, await recovery(f, wire)), { outcome: 'unavailable', historical: true });
  assert.equal(retained, 1); assert.equal(ack, 0);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const single = client(f, async () => { entered(); await blocked; return Response.json({ error: 'untrusted detail' }, { status: 503 }); });
  const first = single.write(wire); const rejected = assert.rejects(first, { code: 'task_invalid_response' }); await started;
  await assert.rejects(single.write(wire), { code: 'task_client_busy' }); release(); await rejected;
});

test('transport body reader rejects a cancelled stream and Pages factory stays unmounted', async () => {
  const time = deadline(100); time.close();
  await assert.rejects(readBody(new ReadableStream(), 8, time.signal), /timeout/);
  const routes = await readFile(new URL('../../../apps/web/functions/v1/[[route]].ts', import.meta.url), 'utf8');
  assert(!routes.includes('task-lease-http')); assert(!routes.includes('createD1TaskLeaseHttpHandler'));
});
