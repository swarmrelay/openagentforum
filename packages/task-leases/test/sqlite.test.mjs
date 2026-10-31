import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlite, signed, creation, recovery, invariant, business } from './helpers.mjs';
import { cases } from './contract-cases.mjs';
import { SQLiteTaskLeases } from '../dist/sqlite.js';
import { UPDATE_ACTOR_SQL } from '../dist/sql.js';

cases('SQLite', sqlite);

test('SQLite creates, claims, seals and recovers after a complete database restart', async t => {
  const f = await sqlite(t), task = await f.create(), claim = await f.claim(task);
  const wire = await signed(f, f.actors[1], 'submit', claim, { generation: claim.generation, resultPayload: { done: true } });
  const result = await f.apply(wire); assert.equal(result.receipt.status, 'completed');
  const before = invariant(await f.inspect(), f.options);
  await f.restart();
  assert.deepEqual((await f.recover(await recovery(f, wire))).receipt, result.receipt);
  assert.deepEqual((await f.apply(wire)).receipt, result.receipt);
  assert.deepEqual(business(await f.inspect()), business(before));
  const read = await f.read(task.taskId); assert.equal(read.status, 'completed');
  assert.equal('result' in read, false);
});

test('SQLite manual release requires creator reconciliation and same-key reacquisition is fenced', async t => {
  const f = await sqlite(t), task = await f.create(), first = await f.claim(task);
  const stale = await signed(f, f.actors[1], 'submit', first, { generation: first.generation, resultPayload: 'old' });
  const release = await signed(f, f.actors[1], 'release', first, { generation: first.generation });
  await f.apply(release); let current = await f.read(task.taskId);
  assert.equal(current.status, 'reconciliation');
  await assert.rejects(f.claim(current), e => e.code === 'reconciliation_required');
  await f.apply(await signed(f, f.actors[0], 'reopen', current, { generation: current.generation, resolutionDigest: 'c3'.repeat(32) }));
  current = await f.read(task.taskId); const second = await f.claim(current);
  assert.equal(second.generation, first.generation + 1);
  await assert.rejects(f.apply(stale), e => e.code === 'revision');
  const wrongGeneration = await signed(f, f.actors[1], 'submit', second, { generation: first.generation, resultPayload: 'old' });
  await assert.rejects(f.apply(wrongGeneration), e => e.code === 'generation');
  invariant(await f.inspect(), f.options);
});

test('SQLite final guard rolls back a missing principal charge and lost COMMIT replies stay uncertain', async t => {
  const f = await sqlite(t), db = f.database(), wire = await creation(f), before = business(await f.inspect());
  let omit = true, lose = false;
  const wrapped = new Proxy(db, { get(target, name) {
    if (name === 'prepare') return sql => target.prepare(omit && sql === UPDATE_ACTOR_SQL ? 'SELECT 1' : sql);
    if (name === 'exec') return sql => {
      const result = target.exec(sql);
      if (lose && sql === 'COMMIT') { lose = false; throw new Error('Fixture lost committed reply'); }
      return result;
    };
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  let store = new SQLiteTaskLeases(wrapped, f.options);
  await assert.rejects(store.commit(await store.prepare(wire)), e => e.code === 'unavailable');
  assert.deepEqual(business(invariant(await f.inspect(), f.options)), before);
  await assert.rejects(store.recover(await recovery(f, wire)), e => e.code === 'unavailable');
  omit = false; store = new SQLiteTaskLeases(wrapped, f.options);
  const token = await store.prepare(wire); lose = true;
  await assert.rejects(store.commit(token), e => e.code === 'unavailable');
  await assert.rejects(store.readTask(JSON.parse((await f.inspect()).task_lease_tasks[0].state_json).taskId), e => e.code === 'unavailable');
  await f.restart();
  assert.equal((await f.recover(await recovery(f, wire))).outcome, 'found');
  const current = invariant(await f.inspect(), f.options); assert.equal(current.task_lease_tasks.length, 1);
  assert.throws(() => f.database().prepare("UPDATE task_lease_tasks SET state_json = state_json").run(), /task_lease_guard_required/);
});

test('SQLite deferred reader failures and autocommit SQLITE_BUSY do not poison a shared store instance', async t => {
  const f = await sqlite(t), db = f.database(), wire = await creation(f);
  let busyNextQuery = false;
  const wrapped = new Proxy(db, { get(target, name) {
    if (name === 'prepare') return sql => {
      const stmt = target.prepare(sql);
      if (!busyNextQuery || !sql.includes('UPDATE task_lease_authority')) return stmt;
      return new Proxy(stmt, { get(s, prop) {
        if (prop === 'all') return () => {
          busyNextQuery = false;
          throw Object.assign(new Error('database is locked'), { errcode: 5 });
        };
        const v = s[prop]; return typeof v === 'function' ? v.bind(s) : v;
      } });
    };
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const shared = new SQLiteTaskLeases(wrapped, f.options);
  await assert.rejects(
    shared.prepare({ async read() { throw new Error('oversized or malformed body'); } }),
    e => e.code === 'invalid',
  );
  const controller = new AbortController();
  await assert.rejects(
    shared.prepare({ signal: controller.signal, async read() { controller.abort(); throw new Error('client aborted'); } }),
    e => e.code === 'preparation_expired',
  );
  busyNextQuery = true;
  await assert.rejects(shared.prepare(wire), e => e.code === 'busy');
  const result = await shared.commit(await shared.prepare(wire));
  assert.equal(result.outcome, 'found');
  assert.equal(result.receipt.action, 'create');
  invariant(await f.inspect(), f.options);
});
