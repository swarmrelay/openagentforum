import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { native } from './d1-helpers.mjs';
import { creation, signed, recovery, invariant, business } from './helpers.mjs';
import { verifyWire } from '../dist/contract.js';
import { path, proofRoute } from '../dist/http-contract.js';
import { TaskLeaseHttpClient } from '../dist/http-client.js';

const operation = async (f, wire, pathname) => ({ url: f.options.origin + (pathname ?? path(proofRoute(await verifyWire(wire)))),
  method: 'POST', headers: { 'content-type': 'application/json' }, body: wire });
const call = (f, requests, extra = {}) => f.call('http', { requests, ...extra });
function client(f, actor) {
  return new TaskLeaseHttpClient({ ...f.options, actorKey: actor.signingPublicKey, async fetch(url, init) {
    const { replies } = await call(f, [{ url, method: init.method, headers: init.headers, body: init.body }]);
    return new Response(replies[0].body, { status: replies[0].status, headers: replies[0].headers });
  } });
}

test('Pages factory charges native D1 before body pulls and keeps completion/recovery capacity separate', async t => {
  const f = await native(t, { attempts: { ordinary: 2, completion: 1, recovery: 1 } });
  const wire = await creation(f), created = await call(f, [await operation(f, wire)]);
  assert.equal(created.replies[0].status, 200); assert.equal(created.trace.atPull.ordinary, 1);
  assert.equal(created.trace.batches, 1);
  const id = JSON.parse(created.replies[0].body).receipt.taskId;
  const claimWire = await signed(f, f.actors[1], 'claim', await f.read(id));
  const claim = await client(f, f.actors[1]).write(claimWire);
  const refused = await call(f, [await operation(f, wire)]);
  assert.equal(refused.replies[0].status, 429); assert.equal(refused.trace.pulls, 0);
  const submit = await signed(f, f.actors[1], 'submit', await f.read(id), { generation: claim.receipt.generation, resultPayload: { done: true } });
  assert.equal((await client(f, f.actors[1]).write(submit)).receipt.status, 'completed');
  assert.deepEqual((await client(f, f.actors[1]).recover(claimWire, await recovery(f, claimWire))).receipt, claim.receipt);
  invariant(await f.inspect(), f.options);
});

test('native HTTP route/UTF-8/time refusals preserve business state, and GET/HEAD remain read-only', async t => {
  const f = await native(t), task = await f.create(), wire = await signed(f, f.actors[1], 'claim', task);
  const before = business(await f.inspect());
  const wrong = await operation(f, wire, `/v1/task-leases/${task.taskId}/release`);
  const invalid = { ...await operation(f, wire), bytes: [255] }, stalled = { ...await operation(f, wire), stall: true };
  const response = await call(f, [wrong, invalid, stalled], { bodyTimeoutMs: 50 });
  assert.deepEqual(response.replies.map(r => r.status), [400, 400, 408]);
  assert.deepEqual(business(await f.inspect()), before);
  await f.claim(task); await f.age(task.taskId);
  const state = await f.inspect();
  const reads = await call(f, ['GET', 'HEAD'].map(method => ({ url: f.options.origin + `/v1/task-leases/${task.taskId}`, method })));
  assert.equal(JSON.parse(reads.replies[0].body).task.leaseState, 'expired');
  assert.equal(reads.replies[1].body, ''); assert.equal(reads.trace.charges, 0);
  assert.deepEqual(await f.inspect(), state);
});

test('a lost D1 commit response reports unknown, poisons that HTTP handler, and recovers only its exact receipt after restart', async t => {
  const f = await native(t), wire = await creation(f), request = await operation(f, wire);
  const result = await call(f, [request, request], { fault: 'batch-after' });
  assert.equal(result.trace.batches, 1); assert.equal(result.trace.committed, true);
  assert.deepEqual(result.replies.map(r => JSON.parse(r.body).error), ['task_outcome_unknown', 'task_unavailable']);
  assert.equal((await f.inspect()).task_lease_tasks.length, 1);
  await f.restart();
  const recovered = await client(f, f.actors[0]).recover(wire, await recovery(f, wire));
  assert.equal(recovered.outcome, 'found'); assert.equal(recovered.historical, true);
  assert.equal((await f.inspect()).task_lease_tasks.length, 1);
});

async function processClient(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/http-client-process.mjs', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
    let out = '', error = ''; child.stdout.on('data', value => { out += value; }); child.stderr.on('data', value => { error += value; });
    child.on('error', reject); child.on('exit', code => {
      if (code !== 0) reject(new Error(`Fixture client failed (${code}): ${error}`));
      else { try { resolve(JSON.parse(out)); } catch (failure) { reject(failure); } }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
test('separate client processes preserve a pre-POST journal and recover after full local D1 restart', async t => {
  const f = await native(t), scratch = await mkdtemp(join(tmpdir(), 'task-http-client-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const wire = await creation(f), journalPath = join(scratch, 'journal.json');
  const input = { options: f.options, actorKey: f.actors[0].signingPublicKey, journalPath, originalWire: wire };
  assert.deepEqual(await processClient({ ...input, fixtureUrl: await f.fixtureUrl(), mode: 'lose' }), { ok: true, sends: 1, acknowledged: false });
  const pending = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(pending.operation.wire, wire); assert.equal(pending.receipt, null);
  const before = business(await f.inspect()); await f.restart();
  assert.deepEqual(await processClient({ ...input, fixtureUrl: await f.fixtureUrl(), mode: 'recover', queryWire: await recovery(f, wire) }),
    { ok: true, sends: 1, acknowledged: true });
  const saved = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(saved.operation.wire, wire); assert.equal(saved.receipt.commandDigest, (await verifyWire(wire)).digest);
  assert.deepEqual(business(await f.inspect()), before); invariant(await f.inspect(), f.options);
});
