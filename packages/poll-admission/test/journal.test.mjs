import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAgentKeyPair, deriveAgentId } from '@openagentforum/protocol';
import { options, signed, fixture, opening } from './helpers.mjs';
import { native, closing, ballot } from './d1-helpers.mjs';
import { SQLitePollJournal, provisionPollJournal } from '../dist/sqlite-journal.js';
import { PollHttpClient, JournaledPollClient } from '../dist/http-client.js';

function open(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;'); return db;
}
async function setup(t, config, actor) {
  const directory = await mkdtemp(join(tmpdir(), 'oaf-poll-client-')), path = join(directory, 'journal.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pins = { origin: config.origin, generation: config.generation, policyRevision: config.policyRevision,
    actorKey: actor.signingPublicKey, maxOperations: 16, maxBytes: 1024 * 1024 };
  const db = open(path); provisionPollJournal(db, pins); db.close(); return { path, pins };
}
async function processOperation(t, f, journal, message, fault) {
  const child = fork(fileURLToPath(new URL('./journal-process.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let calls = 0, result, failure;
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('message', async data => {
      try {
        if (data.kind === 'fetch') {
          calls++; assert.equal(new URL(data.url).origin, f.options.origin);
          const response = await f.call('http', { path: new URL(data.url).pathname, body: data.body, fault });
          child.send({ kind: 'response', response });
        } else if (data.kind === 'done') result = data;
      } catch (error) { failure = error; child.kill(); }
    });
    child.on('exit', code => {
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error('Journal child did not finish naturally'));
      else resolve({ ...result, calls });
    });
  });
  child.send({ kind: 'start', path: journal.path, options: journal.pins, ...message });
  return done;
}

test('separate client processes retain exact wires durably across unknown commits and D1/client restarts', async t => {
  const f = await native(t), owner = await setup(t, f.options, f.actors[0]), voter = await setup(t, f.options, f.actors[1]);
  const root = await f.open(), vote = await ballot(root, f.actors[1]);
  let response = await processOperation(t, f, owner, { operation: 'write', id: root.id, wire: JSON.stringify(root) });
  assert.equal(response.ok, true); assert.equal(response.calls, 1);
  response = await processOperation(t, f, voter, { operation: 'write', id: vote.id, wire: JSON.stringify(vote) }, 'batch-after');
  assert.equal(response.ok, false); assert.equal(response.code, 'poll_outcome_unknown'); assert.equal(response.calls, 1);
  let db = open(voter.path), journal = new SQLitePollJournal(db, voter.pins);
  assert.equal(journal.get(vote.id).operation.wire, JSON.stringify(vote)); assert.equal(journal.get(vote.id).receipt, null); db.close();
  await f.restart();
  response = await processOperation(t, f, voter, { operation: 'recover', id: vote.id });
  assert.equal(response.ok, true); assert.equal(response.calls, 1);
  assert.equal(response.retained.receipt.storedSeq, 2);
  const close = await closing(root, f.actors[0]);
  response = await processOperation(t, f, owner, { operation: 'write', id: close.id, wire: JSON.stringify(close) });
  assert.equal(response.ok, true); assert.equal(response.retained.receipt.storedSeq, 3);
  assert.equal((await f.inspect()).messages.length, 3);
});

test('finite journal capacity reserves acknowledgment space and conflicts never replace retained operations', async t => {
  const actor = await generateAgentKeyPair(), config = options(), j = await setup(t, config, actor), db = open(j.path);
  t.after(() => db.close());
  const transport = new PollHttpClient({ ...config, actorKey: actor.signingPublicKey });
  const wire = JSON.stringify(await signed(actor, 'intel', { fixture: 'one' })), operation = await transport.describe(wire);
  // Keep the journal's synchronous sender check pinned to the protocol helper.
  // Retaining this real signed operation must still succeed if derivation changes.
  assert.equal(JSON.parse(wire).sender, await deriveAgentId(actor.signingPublicKey));
  // Provisioning is explicit and cannot reset an existing journal.
  assert.throws(() => provisionPollJournal(db, j.pins), e => e.code === 'unavailable');
  const journal = new SQLitePollJournal(db, j.pins);
  await journal.retain(operation); await journal.retain(operation);
  await assert.rejects(journal.retain({ ...operation, wire: operation.wire + ' ' }), e => e.code === 'conflict');
  assert.equal(journal.get(operation.id).operation.wire, wire);
  assert.throws(() => new SQLitePollJournal(db, { ...j.pins, generation: 'cd'.repeat(32) }), e => e.code === 'unavailable');
  for (let i = 1; i < j.pins.maxOperations; i++) await journal.retain(await transport.describe(JSON.stringify(await signed(actor, 'intel', { i }))));
  const last = await transport.describe(JSON.stringify(await signed(actor, 'intel', { overflow: true })));
  await assert.rejects(journal.retain(last), e => e.code === 'capacity');
  const env = JSON.parse(wire), receipt = { origin: config.origin, generation: config.generation, policyRevision: config.policyRevision,
    actorKey: actor.signingPublicKey, id: env.id, channel: env.channel, signature: env.signature, checksum: env.checksum,
    storedSeq: 1, pollRevision: null, committedAt: Date.now(), historical: true };
  await journal.acknowledge(operation, receipt);
  assert.deepEqual(journal.get(operation.id).receipt, receipt);
  await assert.rejects(journal.acknowledge(operation, { ...receipt, storedSeq: 2 }), e => e.code === 'conflict');
});

test('lost local acknowledgment leaves exact operation available after reopening and never reposts', async t => {
  const actor = await generateAgentKeyPair(), f = fixture(t, [actor]), j = await setup(t, f.config, actor), db = open(j.path);
  t.after(() => db.close());
  const journal = new SQLitePollJournal(db, j.pins), root = await opening(actor), store = f.client();
  const result = store.commit(await store.prepare(JSON.stringify(root)));
  let calls = 0;
  const transport = new PollHttpClient({ ...f.config, actorKey: actor.signingPublicKey, async fetch() {
    calls++; return Response.json({ ok: true, ...result });
  } });
  const client = new JournaledPollClient(transport, { retain: operation => journal.retain(operation),
    async acknowledge() { throw new Error('Fixture local ACK failed'); } });
  await assert.rejects(client.write(JSON.stringify(root)), /Fixture local ACK failed/); assert.equal(calls, 1);
  const reopened = open(j.path);
  try { assert.equal(new SQLitePollJournal(reopened, j.pins).get(root.id).receipt, null); } finally { reopened.close(); }
  assert.equal(journal.get(root.id).operation.wire, JSON.stringify(root));
});

test('uncertain local retention never sends, poisons its instance and remains inspectable after restart', async t => {
  const actor = await generateAgentKeyPair(), config = options(), j = await setup(t, config, actor), db = open(j.path);
  t.after(() => db.close());
  let armed = false, calls = 0;
  const wrapped = new Proxy(db, { get(target, name) {
    if (name === 'exec') return sql => {
      const result = target.exec(sql);
      if (armed && sql === 'COMMIT') { armed = false; throw new Error('Fixture lost journal COMMIT reply'); }
      return result;
    };
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const journal = new SQLitePollJournal(wrapped, j.pins);
  const client = new JournaledPollClient(new PollHttpClient({ ...config, actorKey: actor.signingPublicKey,
    async fetch() { calls++; throw new Error('Must not send'); } }), journal);
  const env = await signed(actor, 'intel', { fixture: true }); armed = true;
  await assert.rejects(client.write(JSON.stringify(env)), e => e.code === 'unavailable'); assert.equal(calls, 0);
  assert.throws(() => journal.get(env.id), e => e.code === 'unavailable');
  const reopened = open(j.path);
  try {
    const retained = new SQLitePollJournal(reopened, j.pins).get(env.id);
    assert.equal(retained.operation.wire, JSON.stringify(env)); assert.equal(retained.receipt, null);
  } finally { reopened.close(); }
});

test('malformed retained acknowledgment fails closed, including JSON scalars and null', async t => {
  const actor = await generateAgentKeyPair(), config = options();
  for (const invalid of ['false', 'null', '0', '""', '{}']) {
    const j = await setup(t, config, actor), db = open(j.path);
    try {
      const journal = new SQLitePollJournal(db, j.pins), transport = new PollHttpClient({ ...config, actorKey: actor.signingPublicKey });
      const operation = await transport.describe(JSON.stringify(await signed(actor, 'intel', { fixture: true })));
      await journal.retain(operation);
      db.prepare('UPDATE poll_client_operations SET receipt_json = ? WHERE id = ?').run(invalid, operation.id);
      assert.throws(() => journal.get(operation.id), e => e.code === 'unavailable');
      assert.throws(() => journal.get(operation.id), e => e.code === 'unavailable');
    } finally { db.close(); }
  }
});
