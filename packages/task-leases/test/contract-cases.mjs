import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeJson, generateAgentKeyPair } from '@openagentforum/protocol';
import { signCommand, verifyWire, FIXED_BYTES, GUARD_BYTES, TASK_BYTES } from '../dist/contract.js';
import * as model from '../../../docs/rfc/fixtures/task-lease-reference.mjs';
import { creation, signed, recovery, invariant, business } from './helpers.mjs';

export function cases(name, make) {
  test(`${name}: native transitions match the independent RFC model at actual database commit times`, async t => {
    const f = await make(t), task = await f.create();
    let reference = model.initialState({ audience: f.options.audience, taskId: task.taskId, creatorKey: f.actors[0].signingPublicKey,
      timeoutMs: 60000, reassignment: 'manual', now: task.receipt.committedAt });
    const steps = [
      ['claim', 1, () => ({})], ['release', 1, s => ({ generation: s.generation })],
      ['reopen', 0, s => ({ generation: s.generation, resolutionDigest: 'c4'.repeat(32) })],
      ['claim', 2, () => ({})], ['submit', 2, s => ({ generation: s.generation, resultPayload: { final: 'sealed' } })],
    ];
    for (const [action, index, payload] of steps) {
      const current = await f.read(task.taskId), wire = await signed(f, f.actors[index], action, current, payload(current));
      const result = await f.apply(wire), expected = model.commit(reference, await model.prepare(wire), result.receipt.committedAt);
      assert.deepEqual(result.receipt, expected.receipt); reference = expected.state;
      const actual = JSON.parse((await f.inspect()).task_lease_tasks[0].state_json); delete actual.content;
      assert.deepEqual(actual, reference);
    }
    invariant(await f.inspect(), f.options);
  });

  test(`${name}: signed creation is deterministic and legacy/noncanonical/tampered proofs fail`, async t => {
    const f = await make(t), wire = await creation(f), proof = await verifyWire(wire);
    const result = await f.apply(wire), before = business(await f.inspect());
    assert.equal(result.receipt.taskId, 'task_' + proof.digest);
    assert.deepEqual((await f.apply(wire)).receipt, result.receipt); assert.deepEqual(business(await f.inspect()), before);
    const changed = JSON.parse(wire); changed.command.payload.title = 'Different signed content';
    await assert.rejects(f.apply(canonicalizeJson(changed)), e => e.code === 'signature');
    await assert.rejects(f.apply(wire + '\n'), e => e.code === 'invalid');
    await assert.rejects(f.apply(JSON.stringify({ action: 'claim', taskId: 'task_0123456789abcdef', signature: '0'.repeat(128) })), e => e.code === 'invalid');
    for (const change of [{ timeoutMs: 59999 }, { timeoutMs: 86400001 }, { reassignment: 'automatic' }]) {
      await assert.rejects(creation(f, change), e => e.code === 'invalid');
    }
    invariant(await f.inspect(), f.options);
  });

  test(`${name}: expired reads never mutate; manual work needs creator reconciliation`, async t => {
    const f = await make(t), task = await f.create(), claim = await f.claim(task);
    await f.age(task.taskId); const before = await f.inspect(), current = await f.read(task.taskId);
    assert.equal(current.status, 'claimed'); assert.equal(current.leaseState, 'expired'); assert.equal(current.reconciliationRequired, true);
    assert.deepEqual(await f.inspect(), before);
    await assert.rejects(f.claim(current), e => e.code === 'reconciliation_required');
    await assert.rejects(f.apply(await signed(f, f.actors[1], 'submit', current,
      { generation: current.generation, resultPayload: 'too late' })), e => e.code === 'lease_expired');
    await assert.rejects(f.apply(await signed(f, f.actors[2], 'reopen', current,
      { generation: current.generation, resolutionDigest: 'd5'.repeat(32) })), e => e.code === 'creator');
    await f.apply(await signed(f, f.actors[0], 'reopen', current,
      { generation: current.generation, resolutionDigest: 'd5'.repeat(32) }));
    const second = await f.claim(await f.read(task.taskId)); assert.equal(second.generation, claim.generation + 1);
    invariant(await f.inspect(), f.options);
  });

  test(`${name}: repeatable work fences expired same-key leases and keeps spent reservations`, async t => {
    const f = await make(t), task = await f.create({ reassignment: 'safe-to-repeat' }), claim = await f.claim(task);
    const old = await signed(f, f.actors[1], 'submit', claim, { generation: claim.generation, resultPayload: 'old' });
    await f.age(task.taskId); const next = await f.claim(await f.read(task.taskId));
    assert.equal(next.generation, 2); await assert.rejects(f.apply(old), e => e.code === 'revision');
    await assert.rejects(f.apply(await signed(f, f.actors[1], 'release', next, { generation: 1 })), e => e.code === 'generation');
    await f.apply(await signed(f, f.actors[1], 'submit', next, { generation: 2, resultPayload: 'current' }));
    const s = invariant(await f.inspect(), f.options);
    assert.equal(s.task_lease_actors.find(a => a.public_key === f.actors[1].signingPublicKey).reserved, 1);
  });

  test(`${name}: completion before expiry and reassignment after expiry have one winning state`, async t => {
    for (const expired of [false, true]) await t.test(expired ? 'reassignment wins' : 'completion wins', async t => {
      const f = await make(t), task = await f.create({ reassignment: 'safe-to-repeat' }), claim = await f.claim(task);
      if (expired) await f.age(task.taskId);
      const wires = [await signed(f, f.actors[1], 'submit', claim, { generation: claim.generation, resultPayload: 'done' }),
        await signed(f, f.actors[2], 'claim', claim)];
      // Separate scopes and the same signed revision. Both are evaluated against
      // current primary time; reads never perform the expiry transition.
      const outcomes = await Promise.allSettled(wires.map(w => f.apply(w)));
      const winners = outcomes.filter(o => o.status === 'fulfilled'); assert(winners.length <= 1);
      // Shared attempt admission may refuse one concurrent charge with `busy`.
      // An explicit exact-byte retry is tested only after both native calls have
      // settled with known refusals; no fresh operation ID/revision is created.
      if (!winners.length) {
        assert(outcomes.every(o => o.status === 'rejected' && ['busy', 'claimed', 'lease_expired'].includes(o.reason.code)));
        winners.push({ value: await f.apply(wires[expired ? 1 : 0]) });
      }
      assert.equal(winners[0].value.receipt.action, expired ? 'claim' : 'submit');
      assert.equal((await f.read(task.taskId)).status, expired ? 'claimed' : 'completed');
      invariant(await f.inspect(), f.options);
    });
  });

  test(`${name}: service storage exhaustion preserves holder completion and exact historical recovery`, async t => {
    const f = await make(t, { maxTasks: 1, creatorTasks: 1, actorActions: 2,
      maxBytes: 5 * FIXED_BYTES + GUARD_BYTES + TASK_BYTES });
    const task = await f.create(), claim = await f.claim(task);
    await assert.rejects(f.apply(await creation(f)), e => e.code === 'capacity');
    const wire = await signed(f, f.actors[1], 'submit', claim, { generation: 1, resultPayload: 'finished at capacity' });
    const result = await f.apply(wire); assert.equal(result.receipt.status, 'completed');
    assert.deepEqual((await f.recover(await recovery(f, wire))).receipt, result.receipt);
    invariant(await f.inspect(), f.options);
  });

  test(`${name}: ordinary attempt exhaustion cannot consume completion or receipt allowance`, async t => {
    const f = await make(t, { attempts: { ordinary: 2, completion: 1, recovery: 1 } });
    const task = await f.create(), claim = await f.claim(task);
    await assert.rejects(f.apply(await creation(f)), e => e.code === 'attempt_capacity');
    const wire = await signed(f, f.actors[1], 'release', claim, { generation: 1 });
    const result = await f.apply(wire);
    assert.deepEqual((await f.recover(await recovery(f, wire))).receipt, result.receipt);
    await assert.rejects(f.recover(await recovery(f, wire)), e => e.code === 'attempt_capacity');
    invariant(await f.inspect(), f.options);
  });

  test(`${name}: full key, audience and current registration scope writes and receipt reads`, async t => {
    const f = await make(t), task = await f.create(), claim = await f.claim(task), outsider = await generateAgentKeyPair();
    const wrongAudience = await signed(f, f.actors[2], 'claim', task, {}, { audience: 'ff'.repeat(32) });
    await assert.rejects(f.apply(wrongAudience), e => e.code === 'scope');
    await assert.rejects(f.apply(await signed(f, outsider, 'claim', task)), e => e.code === 'scope');
    const recovered = await f.recover(await recovery(f, claim.wire, f.actors[2])); assert.equal(recovered.outcome, 'unavailable');
    await f.sql('UPDATE task_lease_actors SET enabled = 0 WHERE public_key = ?', [f.actors[1].signingPublicKey]);
    assert.equal((await f.recover(await recovery(f, claim.wire))).outcome, 'unavailable');
    await assert.rejects(f.apply(await signed(f, f.actors[1], 'release', claim, { generation: 1 })), e => e.code === 'scope');
  });

  test(`${name}: operation conflicts cannot replace receipts or a sealed result`, async t => {
    const f = await make(t), task = await f.create(), claim = await f.claim(task);
    const command = JSON.parse(claim.wire).command; command.expiresAt++;
    const conflict = await signCommand(command, f.actors[1].signingPrivateKey);
    await assert.rejects(f.apply(conflict), e => e.code === 'operation_conflict');
    const submit = await signed(f, f.actors[1], 'submit', claim, { generation: 1, resultPayload: 'immutable' });
    await f.apply(submit); const current = await f.read(task.taskId);
    await assert.rejects(f.apply(await signed(f, f.actors[1], 'submit', current,
      { generation: 1, resultPayload: 'replacement' })), e => e.code === 'sealed');
    const before = business(await f.inspect());
    assert.equal((await f.apply(claim.wire)).receipt.revision, 1);
    assert.deepEqual(business(await f.inspect()), before); invariant(await f.inspect(), f.options);
  });

  test(`${name}: all 128 transition receipts survive saturation and the final holder slot`, async t => {
    const f = await make(t), task = await f.create({ reassignment: 'safe-to-repeat' });
    let current = task, first;
    for (let i = 0; i < 64; i++) {
      current = await f.claim(current); first ??= current.wire;
      if (i === 63) assert.equal(current.revision, 127);
      await f.apply(await signed(f, f.actors[1], 'release', current, { generation: current.generation }));
      current = await f.read(task.taskId);
    }
    assert.equal(current.revision, 128);
    await assert.rejects(f.claim(current), e => e.code === 'capacity');
    assert.equal((await f.recover(await recovery(f, first))).receipt.revision, 1);
    assert.equal((await f.apply(first)).receipt.revision, 1);
    invariant(await f.inspect(), f.options);
  });
}
