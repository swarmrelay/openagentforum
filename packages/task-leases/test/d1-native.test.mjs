import test from 'node:test';
import assert from 'node:assert/strict';
import { native } from './d1-helpers.mjs';
import { signed, creation, recovery, invariant, business } from './helpers.mjs';
import { cases } from './contract-cases.mjs';
import { DB_NOW } from '../dist/schema.js';
import { signCommand } from '../dist/contract.js';

cases('D1', native);

test('native D1 creates, claims, seals and recovers after a full D1 restart', async t => {
  const f = await native(t), task = await f.create(), claim = await f.claim(task);
  const wire = await signed(f, f.actors[1], 'submit', claim, { generation: claim.generation, resultPayload: { done: true } });
  const result = await f.apply(wire); assert.equal(result.receipt.status, 'completed');
  const before = invariant(await f.inspect(), f.options);
  await f.restart();
  assert.deepEqual((await f.recover(await recovery(f, wire))).receipt, result.receipt);
  assert.deepEqual((await f.apply(wire)).receipt, result.receipt);
  assert.deepEqual(business(await f.inspect()), business(before));
});

test('native D1 independent clients racing the same revision commit exactly one lease', async t => {
  const f = await native(t), task = await f.create();
  const wires = await Promise.all([f.actors[1], f.actors[2]].map(a => signed(f, a, 'claim', task)));
  const result = await f.call('paired', { wires, lanes: ['ordinary', 'ordinary'] });
  assert.equal(result.count, 2);
  assert.equal(result.results.filter(r => r.ok).length, 1);
  assert.equal(result.results.find(r => !r.ok).code, 'stale');
  const state = invariant(await f.inspect(), f.options), taskState = JSON.parse(state.task_lease_tasks[0].state_json);
  assert.equal(taskState.generation, 1); assert.equal(taskState.receipts.length, 1);
});

test('native D1 rollback after each batch stage retains no task, receipt or principal/service allocation', async t => {
  const f = await native(t), wire = await creation(f), before = business(await f.inspect());
  for (let failAfter = 0; failAfter < 9; failAfter++) {
    const response = await f.call('apply', { wire, lane: 'ordinary', failAfter });
    assert.equal(response.code, 'unavailable'); assert.equal(response.trace.failedBatch, true);
    assert.deepEqual(business(invariant(await f.inspect(), f.options)), before);
  }
});

test('native D1 final guard rolls back omitted mutation steps and exact proof/lease expiry', async t => {
  const f = await native(t), wire = await creation(f), before = business(await f.inspect());
  for (const skipStatement of [3, 5, 6]) {
    const response = await f.call('apply', { wire, lane: 'ordinary', skipStatement });
    assert.equal(response.code, 'unavailable'); assert.equal(response.trace.failedBatch, true);
    assert.deepEqual(business(invariant(await f.inspect(), f.options)), before);
  }
  let response = await f.call('apply', { wire, lane: 'ordinary', beforeFinal: {
    sql: `UPDATE task_lease_guard SET plan_json = json_set(plan_json, '$.proofExpiresAt', ${DB_NOW}) WHERE id = 1`,
  } });
  assert.equal(response.code, 'unavailable'); assert.equal(response.trace.failedBatch, true);
  assert.deepEqual(business(invariant(await f.inspect(), f.options)), before);
  const task = await f.create(), claim = await f.claim(task), claimed = business(await f.inspect());
  const submit = await signed(f, f.actors[1], 'submit', claim, { generation: 1, resultPayload: 'must roll back' });
  response = await f.call('apply', { wire: submit, lane: 'completion', beforeFinal: {
    sql: `UPDATE task_lease_guard SET plan_json = json_set(plan_json, '$.submitDeadline', ${DB_NOW}) WHERE id = 1`,
  } });
  assert.equal(response.code, 'unavailable'); assert.equal(response.trace.failedBatch, true);
  assert.deepEqual(business(invariant(await f.inspect(), f.options)), claimed);
});

test('native D1 lost committed reply poisons the scope and a fresh process can recover the original receipt', async t => {
  const f = await native(t), wire = await creation(f), query = await recovery(f, wire);
  const response = await f.call('sequence', { fault: 'batch-after', actions: [
    { kind: 'prepare', wire, lane: 'ordinary' }, { kind: 'commit', index: 0 },
    { kind: 'prepare', wire, lane: 'ordinary' }, { kind: 'recover', wire: query },
  ] });
  assert.equal(response.results[0].ok, true);
  assert(response.results.slice(1).every(r => r.code === 'unavailable'));
  const saved = invariant(await f.inspect(), f.options); assert.equal(saved.task_lease_tasks.length, 1);
  assert.equal(response.trace.batches, 1); assert.equal(response.trace.charges, 1);
  await f.restart();
  const result = await f.recover(await recovery(f, wire)); assert.equal(result.outcome, 'found');
  assert.deepEqual(result.receipt, JSON.parse(saved.task_lease_tasks[0].create_receipt));
  assert.deepEqual(business(await f.inspect()), business(saved));
});

test('native D1 late charge/read/batch replies never return fresh success or pull an uncharged body', async t => {
  for (const fault of ['charge-late', 'read-late', 'batch-late-before', 'batch-late-after']) await t.test(fault, async t => {
    const f = await native(t), wire = await creation(f);
    const result = await f.call('apply', { wire, lane: 'ordinary', fault, deferred: true });
    assert.equal(result.ok, false); assert(['preparation_expired', 'unavailable'].includes(result.code));
    const state = invariant(await f.inspect(), f.options);
    assert.equal(state.task_lease_tasks.length, fault === 'batch-late-after' ? 1 : 0);
    if (fault === 'charge-late') assert.equal(result.trace.pulls, 0);
  });
});

test('native D1 schema/current actor changes after verification cannot use the old preparation', async t => {
  const f = await native(t), wire = await creation(f);
  let response = await f.call('apply', { wire, lane: 'ordinary', beforeBatch: {
    sql: 'UPDATE task_lease_actors SET enabled = 0 WHERE public_key = ?', values: [f.actors[0].signingPublicKey],
  } });
  assert.equal(response.code, 'stale'); assert.equal((await f.inspect()).task_lease_tasks.length, 0);
  await f.sql('UPDATE task_lease_actors SET enabled = 1 WHERE public_key = ?', [f.actors[0].signingPublicKey]);
  response = await f.call('apply', { wire, lane: 'ordinary', beforeBatch: { sql: 'DROP TRIGGER task_lease_final_guard' } });
  assert.equal(response.code, 'stale'); assert.equal((await f.inspect()).task_lease_tasks.length, 0);
  response = await f.call('apply', { wire, lane: 'ordinary' }); assert.equal(response.code, 'authority'); assert.equal(response.trace.charges, 0);
});

test('native D1 rejected inputs share durable attempts across fresh instances and keys', async t => {
  const f = await native(t, { attempts: { ordinary: 2, completion: 1, recovery: 1 } });
  for (const wire of ['{', 'null']) {
    const r = await f.call('apply', { wire, lane: 'ordinary', deferred: true });
    assert.equal(r.code, 'invalid'); assert.equal(r.trace.charges, 1); assert.equal(r.trace.pulls, 1);
  }
  await f.restart();
  const r = await f.call('apply', { wire: await creation(f, {}, f.actors[2]), lane: 'ordinary', deferred: true });
  assert.equal(r.code, 'attempt_capacity'); assert.equal(r.trace.pulls, 0);
  invariant(await f.inspect(), f.options);
});

test('native D1 short proof expiry after commit withholds success and fresh recovery still works', async t => {
  const f = await native(t), command = JSON.parse(await creation(f)).command;
  command.expiresAt = Date.now() + 3000;
  const wire = await signCommand(command, f.actors[0].signingPrivateKey);
  const result = await f.call('apply', { wire, lane: 'ordinary', fault: 'batch-late-after', delayMs: 3500 });
  assert.equal(result.code, 'unavailable'); assert.equal(result.trace.committed, true);
  assert.equal((await f.inspect()).task_lease_tasks.length, 1);
  await assert.rejects(f.apply(wire), e => e.code === 'proof_expired');
  const recovered = await f.recover(await recovery(f, wire)); assert.equal(recovered.outcome, 'found');
  invariant(await f.inspect(), f.options);
});
