import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAgentKeyPair, canonicalizeJson, signTaskAction } from '../packages/protocol/dist/index.js';
import { PROFILE, LIMITS, initialState, signCommand, prepare, commit, recover, view }
  from '../docs/rfc/fixtures/task-lease-reference.mjs';

const [creator, alice, bob] = await Promise.all(Array.from({ length: 3 }, () => generateAgentKeyPair()));
const NOW = 1_800_000_000_000, audience = '1'.repeat(64), taskId = 'task_' + '2'.repeat(64);
let serial = 0;
const op = () => (++serial).toString(16).padStart(32, '0');
const fresh = (options = {}) => initialState({ audience, taskId, creatorKey: creator.signingPublicKey,
  timeoutMs: LIMITS.minLeaseMs, reassignment: 'safe-to-repeat', now: NOW, ...options });
const command = (state, key, action = 'claim', payload = {}, now = NOW, extra = {}) => ({
  profile: PROFILE, audience: state.audience, taskId: state.taskId, actorKey: key.signingPublicKey,
  operationId: op(), issuedAt: now, expiresAt: now + LIMITS.proofMs,
  expectedRevision: state.revision, action, payload, ...extra,
});
async function proof(state, key = alice, action = 'claim', payload = {}, now = NOW, extra = {}) {
  const c = command(state, key, action, payload, now, extra);
  const wire = await signCommand(c, key.signingPrivateKey);
  return { wire, token: await prepare(wire), command: c };
}
async function apply(state, key, action, payload, now = NOW, extra = {}) {
  return commit(state, (await proof(state, key, action, payload, now, extra)).token, now);
}
const submission = (state, resultPayload = { value: 'fixture' }) => ({ generation: state.generation, resultPayload });

test('lease duration is bounded and manual reconciliation is the default', () => {
  assert.equal(initialState({ audience, taskId, creatorKey: creator.signingPublicKey, now: NOW }).reassignment, 'manual');
  for (const timeoutMs of [0, -1, 59_999, 86_400_001, 60_000.5, NaN, Infinity, '60000']) {
    assert.throws(() => fresh({ timeoutMs }), /invalid/);
  }
  assert.equal(fresh({ timeoutMs: LIMITS.maxLeaseMs }).timeoutMs, LIMITS.maxLeaseMs);
  assert.throws(() => fresh({ reassignment: 'automatic' }), /invalid/);
  assert.throws(() => fresh({ taskId: 'task_legacy' }), /invalid/);
});

test('canonical wire encoding rejects whitespace, duplicate keys and alternate signature encodings', async () => {
  const { wire } = await proof(fresh());
  const envelope = JSON.parse(wire);
  for (const candidate of [' ' + wire, JSON.stringify(envelope, null, 2),
    wire.replace('"signature":', '"signature":"ignored","signature":'),
    canonicalizeJson({ ...envelope, signature: envelope.signature.toUpperCase() }),
    canonicalizeJson({ ...envelope, signature: envelope.signature + '\n' }),
    canonicalizeJson({ ...envelope, extra: true })]) {
    await assert.rejects(prepare(candidate), /noncanonical|invalid/);
  }
});

test('legacy task signatures cannot authorize the new profile', async () => {
  const { wire } = await proof(fresh()); const envelope = JSON.parse(wire);
  envelope.signature = await signTaskAction({ action: 'claim', taskId, agentId: alice.agentId,
    timestamp: NOW, payload: {} }, alice.signingPrivateKey);
  await assert.rejects(prepare(canonicalizeJson(envelope)), /signature/);
});

test('signature binds full key, relay audience, task, operation, deadline, revision and payload', async () => {
  const state = (await apply(fresh(), alice, 'claim', {})).state;
  const { wire } = await proof(state, alice, 'submit', submission(state));
  const changes = { audience: '3'.repeat(64), taskId: 'task_' + '4'.repeat(64), actorKey: bob.signingPublicKey,
    operationId: op(), issuedAt: NOW - 1, expiresAt: NOW + LIMITS.proofMs - 1, expectedRevision: 0,
    payload: submission(state, 'modified') };
  for (const [field, value] of Object.entries(changes)) {
    const envelope = JSON.parse(wire); envelope.command[field] = value;
    await assert.rejects(prepare(canonicalizeJson(envelope)), /signature|invalid/);
  }
});

test('verification snapshots signing input and cannot be forged by copying a token', async () => {
  const state = fresh(), c = command(state, alice);
  const pending = signCommand(c, alice.signingPrivateKey);
  c.expectedRevision = 99;
  const token = await prepare(await pending);
  assert.throws(() => commit(state, { ...token }, NOW), /unverified/);
  assert.equal(commit(state, token, NOW).state.revision, 1);
});

test('unknown actions, fields, numeric coercions, excessive lifetimes and malformed proofs fail', async () => {
  const state = fresh();
  for (const extra of [{ action: 'renew' }, { expectedRevision: '0' }, { issuedAt: -1 },
    { expiresAt: NOW }, { expiresAt: NOW + LIMITS.proofMs + 1 }, { profile: 'task' },
    { actorKey: alice.signingPublicKey + '\n' }, { unknown: true }]) {
    await assert.rejects(signCommand(command(state, alice, 'claim', {}, NOW, extra), alice.signingPrivateKey), /invalid/);
  }
  for (const wire of ['', '{', 'x'.repeat(LIMITS.wireBytes + 1)]) await assert.rejects(prepare(wire), /invalid/);
  await assert.rejects(proof(state, alice, 'claim', { '': true }), /invalid/);
  await assert.rejects(proof(state, alice, 'release', { 'generation,extra': 1 }), /invalid/);
});

test('bounded JSON rejects deep, broad, nonfinite and oversized result inputs', async () => {
  const state = (await apply(fresh(), alice, 'claim', {})).state;
  let deep = null; for (let i = 0; i < 20; i++) deep = { nested: deep };
  for (const value of [deep, Array(129).fill(0), Infinity, undefined, '🧪'.repeat(5000),
    Array.from({ length: 100 }, () => Array(100).fill(0))]) {
    await assert.rejects(proof(state, alice, 'submit', { generation: state.generation, resultPayload: value }), /invalid/);
  }
});

test('claim time comes from the commit boundary, not the signer or verification start', async () => {
  const state = fresh(), { token } = await proof(state);
  const result = commit(state, token, NOW + 10_000);
  assert.equal(result.state.lease.claimedAt, NOW + 10_000);
  assert.equal(result.state.lease.expiresAt, NOW + 10_000 + LIMITS.minLeaseMs);
  assert.throws(() => commit(state, token, NOW + LIMITS.proofMs), /proof_expired/);
  const future = await proof(state, alice, 'claim', {}, NOW + LIMITS.futureSkewMs + 1);
  assert.throws(() => commit(state, future.token, NOW), /proof_expired/);
});

test('both serializations of competing prepared claims admit only one winner', async () => {
  for (const order of [[alice, bob], [bob, alice]]) {
    const state = fresh();
    const [first, second] = await Promise.all(order.map(key => proof(state, key)));
    const won = commit(state, first.token, NOW);
    assert.throws(() => commit(won.state, second.token, NOW), /revision/);
    assert.equal(won.state.lease.holderKey, order[0].signingPublicKey);
    assert.equal(won.state.receipts.length, 1);
  }
});

test('submit succeeds one millisecond before expiry but fails at equality', async () => {
  const state = (await apply(fresh(), alice, 'claim', {})).state, end = state.lease.expiresAt;
  const { token } = await proof(state, alice, 'submit', submission(state), end - 1);
  assert.equal(commit(state, token, end - 1).state.status, 'completed');
  assert.throws(() => commit(state, token, end), /lease_expired/);
  assert.equal(state.status, 'claimed');
});

test('same-key reacquisition fences old submit/release proofs and old generation with a fresh revision', async () => {
  const first = (await apply(fresh(), alice, 'claim', {})).state, end = first.lease.expiresAt;
  const stale = await proof(first, alice, 'submit', submission(first), end - 1);
  const release = await proof(first, alice, 'release', { generation: 1 }, end - 1);
  const next = (await apply(first, alice, 'claim', {}, end)).state;
  assert.equal(next.generation, 2);
  assert.throws(() => commit(next, stale.token, end), /revision/);
  assert.throws(() => commit(next, release.token, end), /revision/);
  const wrongGeneration = await proof(next, alice, 'submit', { generation: 1, resultPayload: 'late' }, end);
  assert.throws(() => commit(next, wrongGeneration.token, end), /generation/);
  assert.equal((await apply(next, alice, 'submit', submission(next), end)).state.status, 'completed');
});

test('reclaim/submit race cannot both succeed; a sealed result is never reopened', async () => {
  const state = (await apply(fresh(), alice, 'claim', {})).state, end = state.lease.expiresAt;
  const submit = await proof(state, alice, 'submit', submission(state), end - 1);
  const claim = await proof(state, bob, 'claim', {}, end - 1);
  assert.throws(() => commit(state, claim.token, end - 1), /claimed/);
  const completed = commit(state, submit.token, end - 1).state;
  assert.throws(() => commit(completed, claim.token, end), /revision/);
  await assert.rejects(apply(completed, bob, 'claim', {}, end), /sealed/);
  const reassigned = commit(state, claim.token, end).state;
  assert.throws(() => commit(reassigned, submit.token, end), /revision/);
});

test('manual expiry needs creator reconciliation; other agents and premature reopening fail', async () => {
  const state = (await apply(fresh({ reassignment: 'manual' }), alice, 'claim', {})).state;
  const payload = { generation: 1, resolutionDigest: 'a'.repeat(64) }, end = state.lease.expiresAt;
  await assert.rejects(apply(state, bob, 'claim', {}, end), /reconciliation_required/);
  await assert.rejects(apply(state, bob, 'reopen', payload, end), /creator/);
  await assert.rejects(apply(state, creator, 'reopen', payload, end - 1), /reconciliation_required/);
  const reopened = await apply(state, creator, 'reopen', payload, end);
  assert.equal(reopened.state.status, 'open');
  assert.equal(reopened.receipt.resolutionDigest, payload.resolutionDigest);
  const next = (await apply(reopened.state, bob, 'claim', {}, end)).state;
  assert.equal(next.generation, 2);
});

test('manual release does not assert that external effects have been undone', async () => {
  const state = (await apply(fresh({ reassignment: 'manual' }), alice, 'claim', {})).state;
  const released = (await apply(state, alice, 'release', { generation: 1 })).state;
  assert.equal(released.status, 'reconciliation');
  await assert.rejects(apply(released, bob, 'claim', {}), /reconciliation_required/);
  const reopened = (await apply(released, creator, 'reopen', { generation: 1, resolutionDigest: 'b'.repeat(64) })).state;
  assert.equal(reopened.status, 'open');
});

test('unreassigned holder may release after expiry; a different key may not', async () => {
  const state = (await apply(fresh(), alice, 'claim', {})).state, end = state.lease.expiresAt;
  await assert.rejects(apply(state, bob, 'release', { generation: 1 }, end), /holder/);
  const released = (await apply(state, alice, 'release', { generation: 1 }, end)).state;
  assert.equal(released.status, 'open'); assert.equal(released.lease, null);
  assert.equal((await apply(released, bob, 'claim', {}, end)).state.generation, 2);
});

test('exact retries return historical receipts without extending the lease or changing state', async () => {
  const initial = fresh(), original = await proof(initial), first = commit(initial, original.token, NOW);
  const retry = commit(first.state, await prepare(original.wire), NOW + 20_000);
  assert.equal(retry.state, first.state); assert.equal(retry.replayed, true);
  assert.equal(first.historical, true); assert.equal(retry.historical, true);
  assert.deepEqual(retry.receipt, first.receipt); assert.equal(retry.state.receipts.length, 1);
  const changed = command(initial, alice, 'claim', {}, NOW + 1, { operationId: original.command.operationId });
  const altered = await prepare(await signCommand(changed, alice.signingPrivateKey));
  assert.throws(() => commit(first.state, altered, NOW + 1), /operation_conflict/);
});

test('old claim receipt replay cannot reacquire work after another key takes over', async () => {
  const initial = fresh(), original = await proof(initial), first = commit(initial, original.token, NOW);
  const next = (await apply(first.state, bob, 'claim', {}, first.state.lease.expiresAt)).state;
  const retry = commit(next, original.token, first.state.lease.expiresAt);
  assert.equal(retry.replayed, true); assert.equal(retry.state.lease.holderKey, bob.signingPublicKey);
  assert.equal(retry.receipt.generation, 1); assert.equal(view(retry.state, first.state.lease.expiresAt).generation, 2);
});

test('lost acknowledgment survives a model checkpoint; fresh signed recovery works after proof expiry', async () => {
  const initial = fresh(), original = await proof(initial), result = commit(initial, original.token, NOW);
  const restored = JSON.parse(JSON.stringify(result.state)); // model persistence, NOT a database restart test
  assert.equal(commit(restored, await prepare(original.wire), NOW + 1).replayed, true);
  const later = NOW + LIMITS.proofMs;
  assert.throws(() => commit(restored, original.token, later), /proof_expired/);
  const query = await proof(restored, alice, 'receipt', { operationId: original.command.operationId, commandDigest: original.token.digest },
    later, { expectedRevision: null });
  const before = JSON.stringify(restored), found = recover(restored, query.token, later);
  assert.equal(found.outcome, 'found'); assert.equal(found.historical, true);
  assert.deepEqual(found.receipt, result.receipt); assert.equal(JSON.stringify(restored), before);
  assert.throws(() => commit(restored, query.token, later), /read_only/);
});

test('receipt recovery is full-key scoped and missing receipts do not imply no future commit', async () => {
  const initial = fresh(), original = await proof(initial);
  const payload = { operationId: original.command.operationId, commandDigest: original.token.digest };
  const query = await proof(initial, alice, 'receipt', payload, NOW, { expectedRevision: null });
  assert.equal(recover(initial, query.token, NOW).outcome, 'unavailable');
  const committed = commit(initial, original.token, NOW).state;
  assert.equal(recover(committed, query.token, NOW).outcome, 'found');
  const otherKey = await proof(committed, bob, 'receipt', payload, NOW, { expectedRevision: null });
  assert.equal(recover(committed, otherKey.token, NOW).outcome, 'unavailable');
  const otherDigest = await proof(committed, alice, 'receipt', { ...payload, commandDigest: 'f'.repeat(64) }, NOW, { expectedRevision: null });
  assert.equal(recover(committed, otherDigest.token, NOW).outcome, 'unavailable');
  assert.throws(() => recover(committed, query.token, NOW + LIMITS.proofMs), /proof_expired/);
});

test('first completion seals the canonical result and retries do not rewrite it', async () => {
  const state = (await apply(fresh(), alice, 'claim', {})).state;
  const original = await proof(state, alice, 'submit', submission(state, { z: null, a: false }));
  const completed = commit(state, original.token, NOW);
  assert.equal(completed.state.result.canonicalPayload, '{"a":false,"z":null}');
  assert.equal(commit(completed.state, original.token, NOW).replayed, true);
  await assert.rejects(apply(completed.state, alice, 'submit', submission(completed.state, 'replacement')), /sealed/);
  assert.ok(!JSON.stringify(completed.receipt).includes('canonicalPayload'));
  assert.ok(!Object.hasOwn(view(completed.state, NOW), 'result'));
});

test('receipt saturation reserves one terminal slot and does not evict old proofs', async () => {
  let state = fresh();
  for (let i = 0; i < 63; i++) {
    state = (await apply(state, alice, 'claim', {})).state;
    state = (await apply(state, alice, 'release', { generation: state.generation })).state;
  }
  state = (await apply(state, alice, 'claim', {})).state;
  assert.equal(state.receipts.length, 127);
  await assert.rejects(apply(state, bob, 'claim', {}, state.lease.expiresAt), /capacity/);
  const completed = (await apply(state, alice, 'submit', submission(state))).state;
  assert.equal(completed.receipts.length, LIMITS.receipts);
  assert.deepEqual(completed.receipts.slice(0, 127), state.receipts);
});

test('reading expired state does not release it, create a receipt or expose result content', async () => {
  const state = (await apply(fresh({ reassignment: 'manual' }), alice, 'claim', {})).state;
  const before = JSON.stringify(state), read = view(state, state.lease.expiresAt);
  assert.equal(read.status, 'claimed'); assert.equal(read.leaseState, 'expired');
  assert.equal(read.reconciliationRequired, true); assert.equal(JSON.stringify(state), before);
  assert.ok(!Object.hasOwn(read, 'receipts')); assert.ok(!Object.hasOwn(read, 'result'));
});

test('wrong relay/task scope and regressed trusted time fail before transition', async () => {
  const state = fresh(), original = await proof(state);
  assert.throws(() => commit(fresh({ audience: 'f'.repeat(64) }), original.token, NOW), /scope/);
  assert.throws(() => commit(fresh({ taskId: 'task_' + 'f'.repeat(64) }), original.token, NOW), /scope/);
  const next = commit(state, original.token, NOW + 1).state;
  assert.throws(() => commit(next, original.token, NOW), /clock/);
  assert.throws(() => view(next, NOW), /clock/);
});

test('state/result snapshots are immutable and a receipt copy cannot alter retained history', async () => {
  const state = (await apply(fresh(), alice, 'claim', {})).state;
  const original = await proof(state, alice, 'submit', submission(state));
  const { state: completed } = commit(state, original.token, NOW);
  assert.throws(() => { completed.lease.generation = 99; }, TypeError);
  assert.throws(() => { completed.result.canonicalPayload = 'changed'; }, TypeError);
  const query = await proof(completed, alice, 'receipt', { operationId: original.command.operationId,
    commandDigest: original.token.digest }, NOW, { expectedRevision: null });
  const copy = recover(completed, query.token, NOW);
  copy.receipt.status = 'open';
  assert.equal(recover(completed, query.token, NOW).receipt.status, 'completed');
});
