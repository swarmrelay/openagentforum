import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateAgentKeyPair, canonicalizeJson } from '@openagentforum/protocol';
import { PROFILE, FIXED_BYTES, GUARD_BYTES, TASK_BYTES, signCommand, verifyWire } from '../dist/contract.js';
import { SCHEMA_OBJECTS } from '../dist/schema.js';
import { SQLiteTaskLeases } from '../dist/sqlite.js';

export function options(policy = {}) {
  return { origin: 'https://fixture.invalid', audience: 'a1'.repeat(32), generation: 'b2'.repeat(32), policyRevision: 'fixture-1',
    policy: { maxTasks: 32, maxBytes: 16 * 1024 * 1024, maxActors: 3, creatorTasks: 16, actorActions: 512,
      windowMs: 86400000, preparationMs: 5000, attempts: { ordinary: 10000, completion: 10000, recovery: 10000 }, ...policy } };
}
export const tables = ['task_lease_authority', 'task_lease_actors', 'task_lease_tasks', 'task_lease_guard'];
export function seed(config, actors, now) {
  return [
    ...SCHEMA_OBJECTS.map(({ sql }) => ({ sql, values: [] })),
    ...actors.map(a => ({ sql: 'INSERT INTO task_lease_actors VALUES (?, 1, 0, 0, 0)', values: [a.signingPublicKey] })),
    { sql: 'INSERT INTO task_lease_authority VALUES (1, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?)',
      values: [config.origin, config.audience, config.generation, config.policyRevision, canonicalizeJson(config.policy), now,
        Math.floor(now / config.policy.windowMs), canonicalizeJson({ ordinary: 0, completion: 0, recovery: 0 }), actors.length,
        (2 + actors.length) * FIXED_BYTES + GUARD_BYTES] },
  ];
}
export async function signed(f, actor, action, task = null, payload = {}, extra = {}) {
  const now = Date.now();
  return signCommand({ profile: PROFILE, audience: f.options.audience, taskId: task?.taskId ?? null,
    actorKey: actor.signingPublicKey, operationId: crypto.randomUUID().replaceAll('-', ''),
    issuedAt: now - 120000, expiresAt: now + 120000, expectedRevision: task?.revision ?? null, action, payload, ...extra }, actor.signingPrivateKey);
}
export const creation = (f, extra = {}, actor = f.actors[0]) => signed(f, actor, 'create', null,
  { title: 'Local fixture work', description: 'No external execution', requiredCapabilities: [], reward: null,
    timeoutMs: 60000, reassignment: 'manual', ...extra });
export async function recovery(f, wire, actor) {
  const proof = await verifyWire(wire);
  return signed(f, actor ?? f.actors.find(a => a.signingPublicKey === proof.command.actorKey), 'receipt', { taskId: proof.taskId },
    { operationId: proof.command.operationId, commandDigest: proof.digest }, { expectedRevision: null });
}
export function lane(wire) {
  try { return ['submit', 'release'].includes(JSON.parse(wire)?.command?.action) ? 'completion' : 'ordinary'; }
  catch { return 'ordinary'; }
}
export function decorate(f) {
  f.create = async extra => {
    const wire = await creation(f, extra), result = await f.apply(wire);
    assert.equal(result.outcome, 'found'); return { wire, receipt: result.receipt, ...await f.read(result.receipt.taskId) };
  };
  f.claim = async (task, actor = f.actors[1]) => {
    const wire = await signed(f, actor, 'claim', task), result = await f.apply(wire);
    assert.equal(result.outcome, 'found'); return { wire, receipt: result.receipt, ...await f.read(task.taskId) };
  };
  return f;
}
export function invariant(state, config) {
  assert.deepEqual(state.task_lease_guard, []);
  const a = state.task_lease_authority[0];
  assert.equal(a.tasks, state.task_lease_tasks.length); assert.equal(a.actors, state.task_lease_actors.length);
  assert.equal(a.used_bytes, (2 + a.actors) * FIXED_BYTES + GUARD_BYTES + a.tasks * TASK_BYTES);
  assert(a.tasks <= config.policy.maxTasks && a.used_bytes <= config.policy.maxBytes);
  for (const actor of state.task_lease_actors) {
    assert(actor.actions + actor.reserved <= config.policy.actorActions);
    assert.equal(actor.created_tasks, state.task_lease_tasks.filter(t => t.creator_key === actor.public_key).length);
    const receipts = state.task_lease_tasks.flatMap(t => [JSON.parse(t.create_receipt), ...JSON.parse(t.state_json).receipts])
      .filter(r => r.actorKey === actor.public_key);
    assert.equal(actor.actions, receipts.length);
    assert.equal(actor.reserved, receipts.filter(r => r.action === 'claim').length
      - receipts.filter(r => r.action === 'submit' || r.action === 'release').length);
  }
  for (const t of state.task_lease_tasks) {
    const s = JSON.parse(t.state_json); assert.equal(s.revision, s.receipts.length);
    assert.equal(s.generation, s.receipts.filter(r => r.action === 'claim').length);
  }
  return state;
}
export function business(state) {
  const copy = structuredClone(state);
  for (const a of copy.task_lease_authority) { delete a.clock; delete a.window; delete a.attempts_json; }
  return copy;
}
// Explicit fixture-only time relocation of already accepted records. It changes
// all associated receipt clocks consistently, then restores the exact immutable
// trigger before any store operation. It is not a supported recovery/migration.
export function aged(row, ms) {
  const state = JSON.parse(row.state_json), create = JSON.parse(row.create_receipt);
  state.updatedAt -= ms; create.committedAt -= ms;
  if (state.lease) { state.lease.claimedAt -= ms; state.lease.expiresAt -= ms; }
  for (const r of state.receipts) { r.committedAt -= ms; if (r.leaseExpiresAt !== null) r.leaseExpiresAt -= ms; }
  return { state: canonicalizeJson(state), receipt: canonicalizeJson(create) };
}
export async function sqlite(t, policy = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'oaf-task-sqlite-')), path = join(scratch, 'leases.sqlite');
  const config = options(policy), actors = await Promise.all(Array.from({ length: 3 }, () => generateAgentKeyPair()));
  let db;
  function open() {
    db = new DatabaseSync(path); db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA busy_timeout = 1000;');
  }
  open(); for (const s of seed(config, actors, Date.now())) db.prepare(s.sql).run(...s.values);
  t.after(async () => { db.close(); await rm(scratch, { recursive: true, force: true }); });
  const store = () => new SQLiteTaskLeases(db, config);
  const f = { options: config, actors, path, store, database: () => db,
    apply: async wire => { const s = store(); return s.commit(await s.prepare(wire, lane(wire))); },
    recover: wire => store().recover(wire), read: id => store().readTask(id),
    sql: async (sql, values = []) => db.prepare(sql).all(...values),
    inspect: async () => Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()])),
    restart: async () => { db.close(); open(); },
    age: async (id, ms = 60001) => {
      const row = db.prepare('SELECT * FROM task_lease_tasks WHERE task_id = ?').get(id), a = aged(row, ms);
      db.exec('BEGIN IMMEDIATE'); db.exec('DROP TRIGGER task_lease_task_identity'); db.exec('DROP TRIGGER task_lease_state_guard');
      db.prepare('UPDATE task_lease_tasks SET state_json = ?, create_receipt = ? WHERE task_id = ?').run(a.state, a.receipt, id);
      for (const name of ['task_lease_task_identity', 'task_lease_state_guard']) db.exec(SCHEMA_OBJECTS.find(o => o.name === name).sql);
      db.exec('COMMIT');
    },
  };
  return decorate(f);
}
