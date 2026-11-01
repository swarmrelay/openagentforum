import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeJson } from '@openagentforum/protocol';
import { SQLiteTaskLeaseJournal, provisionTaskLeaseJournal, TASK_JOURNAL_COMPLETION_BYTES } from '../dist/sqlite-journal.js';
import { TaskLeaseHttpClient, JournaledTaskLeaseClient } from '../dist/http-client.js';
import { createTaskLeaseHttpHandler } from '../dist/http-server.js';
import { verifyWire } from '../dist/contract.js';
import { sqlite, creation, signed, recovery } from './helpers.mjs';

async function journalFixture(t, f, actor = f.actors[0], overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oaf-task-journal-')), file = join(dir, 'journal.sqlite');
  const { origin, audience, generation, policyRevision } = f.options;
  const config = { origin, audience, generation, policyRevision, actorKey: actor.signingPublicKey,
    maxOperations: 10, maxBytes: 1024 * 1024, ...overrides };
  let db;
  const open = () => { db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;'); };
  open(); await chmod(file, 0o600); provisionTaskLeaseJournal(db, config);
  let journal = new SQLiteTaskLeaseJournal(db, config);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const transport = new TaskLeaseHttpClient({ ...f.options, actorKey: actor.signingPublicKey,
    fetch: (url, init) => createTaskLeaseHttpHandler(f.store(), { ...f.options, bodyTimeoutMs: 1000 })(new Request(url, init)) });
  return { config, file, transport, db: () => db, journal: () => journal,
    client: () => new JournaledTaskLeaseClient(transport, journal),
    reopen() { db.close(); open(); journal = new SQLiteTaskLeaseJournal(db, config); return journal; } };
}

test('journal retains exact signed operations before POST, keeps uncertain intent after reopen, and acknowledges only historical recovery', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f), wire = await creation(f), operation = await j.transport.describe(wire);
  let sends = 0;
  const transport = new TaskLeaseHttpClient({ ...f.options, actorKey: f.actors[0].signingPublicKey, async fetch(url, init) {
    assert.deepEqual(await j.journal().get(operation.operationId), { operation, receipt: null }); sends++;
    const response = await createTaskLeaseHttpHandler(f.store(), { ...f.options, bodyTimeoutMs: 1000 })(new Request(url, init));
    assert.equal(response.status, 200); throw new Error('PRIVATE_LOST_RESPONSE');
  } });
  await assert.rejects(new JournaledTaskLeaseClient(transport, j.journal()).write(wire), { code: 'task_transport_unknown' });
  assert.equal(sends, 1); assert.deepEqual(await j.reopen().get(operation.operationId), { operation, receipt: null });
  assert.deepEqual(await j.journal().pending(), [operation]);
  const recovered = await j.client().recover(wire, await recovery(f, wire));
  assert.equal(recovered.outcome, 'found'); assert.deepEqual((await j.journal().get(operation.operationId)).receipt, recovered.receipt);
  assert.deepEqual(await j.journal().pending(), []);
  assert.equal((await f.inspect()).task_lease_tasks.length, 1);
});

test('full journal prevents dispatch while exact duplicate retention remains idempotent', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f, f.actors[0], { maxOperations: 1 });
  const wire = await creation(f), operation = await j.transport.describe(wire);
  await j.journal().retain(operation); await j.journal().retain(operation);
  let sends = 0;
  const transport = new TaskLeaseHttpClient({ ...f.options, actorKey: f.actors[0].signingPublicKey,
    fetch: async () => { sends++; throw new Error(); } });
  await assert.rejects(new JournaledTaskLeaseClient(transport, j.journal()).write(await creation(f)),
    { code: 'capacity', permitsReplacementMutation: false });
  assert.equal(sends, 0); assert.deepEqual(await j.reopen().get(operation.operationId), { operation, receipt: null });
});

test('claim retention reserves a full completion slot and bytes before dispatch, including a maximum-size result', async t => {
  const f = await sqlite(t), task = await f.create(), actor = f.actors[1];
  const j = await journalFixture(t, f, actor, { maxOperations: 2, maxBytes: TASK_JOURNAL_COMPLETION_BYTES + 10000 });
  const claim = await signed(f, actor, 'claim', task), operation = await j.transport.describe(claim);
  const claimed = await j.client().write(claim);
  await assert.rejects(j.journal().retain(await j.transport.describe(await signed(f, actor, 'claim', task))), { code: 'capacity' });
  j.reopen();
  const submit = await signed(f, actor, 'submit', await f.read(task.taskId),
    { generation: claimed.receipt.generation, resultPayload: 'x'.repeat(16382) });
  const submitted = await j.client().write(submit);
  assert.equal(submitted.receipt.status, 'completed');
  assert.equal(j.db().prepare('SELECT count(*) AS n FROM task_client_operations').get().n, 2);
  assert.equal(j.db().prepare('SELECT count(*) AS n FROM task_client_completion WHERE terminal_id IS NULL').get().n, 0);
  assert.deepEqual((await j.journal().get(operation.operationId)).receipt, claimed.receipt);
  await assert.rejects(j.journal().retain(await j.transport.describe(await signed(f, actor, 'release',
    { taskId: task.taskId, revision: claimed.receipt.revision }, { generation: claimed.receipt.generation }))), { code: 'conflict' });
});

test('claim needs two available slots and its completion reservation survives an unknown claim', async t => {
  const f = await sqlite(t), task = await f.create(), actor = f.actors[1], claim = await signed(f, actor, 'claim', task);
  const tooSmall = await journalFixture(t, f, actor, { maxOperations: 1 });
  await assert.rejects(tooSmall.client().write(claim), { code: 'capacity' });
  assert.equal((await f.read(task.taskId)).status, 'open');
  const j = await journalFixture(t, f, actor, { maxOperations: 2 }), operation = await j.transport.describe(claim);
  await j.journal().retain(operation); j.reopen();
  await assert.rejects(j.journal().retain(await j.transport.describe(await signed(f, actor, 'claim', task))), { code: 'conflict' });
  const terminal = await signed(f, actor, 'release', { taskId: task.taskId, revision: 1 }, { generation: 1 });
  await assert.rejects(j.journal().retain(await j.transport.describe(terminal)), { code: 'conflict' });
  assert.equal(j.db().prepare('SELECT count(*) AS n FROM task_client_completion WHERE terminal_id IS NULL').get().n, 1);
});

test('scope, full actor key, command digest, signature and exact operation reuse are rechecked by the journal', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f), operation = await j.transport.describe(await creation(f));
  for (const patch of [{ origin: 'https://elsewhere.invalid' }, { audience: 'ff'.repeat(32) }, { generation: 'ff'.repeat(32) },
    { policyRevision: 'other' }, { actorKey: f.actors[1].signingPublicKey }, { commandDigest: 'ff'.repeat(32) },
    { taskId: 'task_' + 'ff'.repeat(32) }, { operationId: 'ff'.repeat(16) }, { extra: 'not allowed' }]) {
    await assert.rejects(j.journal().retain({ ...operation, ...patch }), { code: 'conflict' });
  }
  const bad = JSON.parse(operation.wire); bad.signature = '00'.repeat(64);
  await assert.rejects(j.journal().retain({ ...operation, wire: canonicalizeJson(bad) }), { code: 'conflict' });
  await j.journal().retain(operation);
  const replacement = await signed(f, f.actors[0], 'create', null,
    { ...JSON.parse(operation.wire).command.payload, title: 'Changed' }, { operationId: operation.operationId });
  await assert.rejects(j.journal().retain(await j.transport.describe(replacement)), { code: 'conflict' });
  assert.deepEqual(await j.journal().get(operation.operationId), { operation, receipt: null });
  assert.throws(() => new SQLiteTaskLeaseJournal(j.db(), { ...j.config, generation: 'ff'.repeat(32) }), { code: 'unavailable' });
});

test('receipt acknowledgment requires the exact retained proof and cannot overwrite a historical receipt', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f), wire = await creation(f), operation = await j.transport.describe(wire);
  const receipt = (await j.transport.write(wire)).receipt;
  await assert.rejects(j.journal().acknowledge(operation, receipt), { code: 'conflict' });
  await j.journal().retain(operation);
  for (const patch of [{ actorKey: f.actors[1].signingPublicKey }, { taskId: 'task_' + 'ff'.repeat(32) },
    { commandDigest: 'ff'.repeat(32) }, { operationId: 'ff'.repeat(16) }, { revision: 1 }, { status: 'claimed' }]) {
    await assert.rejects(j.journal().acknowledge(operation, { ...receipt, ...patch }), { code: 'conflict' });
  }
  await j.journal().acknowledge(operation, receipt); await j.journal().acknowledge(operation, receipt);
  await assert.rejects(j.journal().acknowledge(operation, { ...receipt, committedAt: receipt.committedAt + 1 }), { code: 'conflict' });
  assert.deepEqual((await j.reopen().get(operation.operationId)).receipt, receipt);
});

test('operations and receipts are snapshotted before asynchronous verification, and each instance is single-flight', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f), operation = await j.transport.describe(await creation(f));
  const snapshot = structuredClone(operation), retaining = j.journal().retain(operation);
  operation.wire = '{}'; operation.origin = 'https://elsewhere.invalid';
  await assert.rejects(j.journal().get(snapshot.operationId), { code: 'busy' });
  await retaining; assert.deepEqual((await j.journal().get(snapshot.operationId)).operation, snapshot);
  const receipt = (await j.transport.write(snapshot.wire)).receipt, expected = structuredClone(receipt);
  const acknowledging = j.journal().acknowledge(snapshot, receipt); receipt.status = 'claimed';
  await acknowledging; assert.deepEqual((await j.journal().get(snapshot.operationId)).receipt, expected);
});

test('a lost journal COMMIT acknowledgment prevents POST, poisons the instance and retains the exact pending operation', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f), wire = await creation(f), operation = await j.transport.describe(wire);
  const originalExec = j.db().exec.bind(j.db()); let armed = true;
  j.db().exec = sql => {
    const result = originalExec(sql);
    // retain first reads, then commits its write. Throw only after the new row is durable.
    if (sql === 'COMMIT' && armed && j.db().prepare('SELECT count(*) AS n FROM task_client_operations').get().n === 1) {
      armed = false; throw new Error('PRIVATE_JOURNAL_DRIVER_MARKER');
    }
    return result;
  };
  await assert.rejects(j.client().write(wire), { code: 'unavailable', permitsReplacementMutation: false });
  assert.equal((await f.inspect()).task_lease_tasks.length, 0);
  await assert.rejects(j.journal().get(operation.operationId), { code: 'unavailable' });
  j.db().exec = originalExec;
  assert.deepEqual(await j.reopen().get(operation.operationId), { operation, receipt: null });
  const unavailable = await j.client().recover(wire, await recovery(f, wire));
  assert.equal(unavailable.outcome, 'unavailable');
  assert.deepEqual(await j.journal().get(operation.operationId), { operation, receipt: null });
});

test('corrupt stored wires or missing reservation authority fail closed without repair or replacement', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f), operation = await j.transport.describe(await creation(f));
  await j.journal().retain(operation);
  const changed = { ...operation, wire: operation.wire.replace('Local fixture work', 'Changed fixture work') };
  j.db().prepare('UPDATE task_client_operations SET operation_json = ? WHERE id = ?').run(canonicalizeJson(changed), operation.operationId);
  await assert.rejects(j.journal().get(operation.operationId), { code: 'unavailable' });
  await assert.rejects(j.journal().retain(operation), { code: 'unavailable' });
});

test('provisioning refuses existing authority and constructors refuse relaxed durability without modifying the database', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f);
  const before = j.db().prepare('SELECT * FROM task_client_authority').all();
  assert.throws(() => provisionTaskLeaseJournal(j.db(), j.config), { code: 'unavailable' });
  for (const pragma of ['PRAGMA synchronous=NORMAL', 'PRAGMA foreign_keys=OFF']) {
    j.db().exec(pragma); assert.throws(() => new SQLiteTaskLeaseJournal(j.db(), j.config), { code: 'unavailable' });
    j.db().exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
  }
  assert.deepEqual(j.db().prepare('SELECT * FROM task_client_authority').all(), before);
});

test('independent journal connections share retained capacity and accept only exact concurrent duplicates', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f, f.actors[0], { maxOperations: 1 });
  const db = new DatabaseSync(j.file); db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
  t.after(() => db.close());
  const second = new SQLiteTaskLeaseJournal(db, j.config), first = await j.transport.describe(await creation(f));
  await Promise.all([j.journal().retain(first), second.retain(first)]);
  const another = await j.transport.describe(await creation(f));
  await assert.rejects(second.retain(another), { code: 'capacity' });
  assert.deepEqual(await second.get(first.operationId), { operation: first, receipt: null });
});

test('byte capacity is independent of slot capacity and a missing claim reservation cannot be silently restored', async t => {
  const f = await sqlite(t), actor = f.actors[1], task = await f.create();
  const small = await journalFixture(t, f, actor, { maxOperations: 10, maxBytes: TASK_JOURNAL_COMPLETION_BYTES });
  const wire = await signed(f, actor, 'claim', task);
  await assert.rejects(small.client().write(wire), { code: 'capacity' });
  assert.equal((await f.read(task.taskId)).status, 'open');
  const j = await journalFixture(t, f, actor), operation = await j.transport.describe(wire);
  await j.journal().retain(operation);
  j.db().exec('DELETE FROM task_client_completion');
  await assert.rejects(j.journal().pending(), { code: 'unavailable' });
  assert.throws(() => new SQLiteTaskLeaseJournal(j.db(), j.config), { code: 'unavailable' });
  assert.equal(j.db().prepare('SELECT count(*) AS n FROM task_client_completion').get().n, 0);
});

test('a corrupt stored receipt is not treated as an unacknowledged intent or permission to resend', async t => {
  const f = await sqlite(t), j = await journalFixture(t, f), wire = await creation(f), operation = await j.transport.describe(wire);
  await j.client().write(wire);
  j.db().prepare("UPDATE task_client_operations SET receipt_json = 'null' WHERE id = ?").run(operation.operationId);
  await assert.rejects(j.journal().retain(operation), { code: 'unavailable' });
  await assert.rejects(j.journal().get(operation.operationId), { code: 'unavailable' });
});
