/** Dedicated internal schema. Never initialize it from an incoming request. */
import { LIMITS, TASK_BYTES, FIXED_BYTES, GUARD_BYTES } from './contract.js';

export const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const integer = (name: string) => `${name} INTEGER NOT NULL CHECK (${name} BETWEEN 0 AND 9007199254740991)`;
const text = (name: string, limit: number) => `${name} TEXT NOT NULL CHECK (length(CAST(${name} AS BLOB)) <= ${limit})`;
const json = (name: string, limit: number) => `${text(name, limit)} CHECK (json_valid(${name}))`;
const definitions = [
  `CREATE TABLE task_lease_authority (
    id INTEGER PRIMARY KEY CHECK (id = 1), ${text('origin', 256)}, ${text('audience', 64)},
    ${text('generation', 64)}, ${text('policy_revision', 128)}, ${json('policy_json', 2048)},
    ${integer('revision')}, ${integer('clock')}, ${integer('window')}, ${json('attempts_json', 256)},
    ${integer('actors')}, ${integer('tasks')}, ${integer('used_bytes')},
    CHECK (actors <= json_extract(policy_json, '$.maxActors') AND tasks <= json_extract(policy_json, '$.maxTasks')),
    CHECK (used_bytes = (2 + actors) * ${FIXED_BYTES} + ${GUARD_BYTES} + tasks * ${TASK_BYTES}),
    CHECK (used_bytes <= json_extract(policy_json, '$.maxBytes'))
  ) STRICT`,
  `CREATE TABLE task_lease_actors (
    public_key TEXT PRIMARY KEY CHECK (length(public_key) = 64), enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    ${integer('created_tasks')}, ${integer('actions')}, ${integer('reserved')}
  ) STRICT`,
  `CREATE TABLE task_lease_tasks (
    task_id TEXT PRIMARY KEY CHECK (length(task_id) = 69), creator_key TEXT NOT NULL REFERENCES task_lease_actors(public_key),
    ${json('state_json', LIMITS.stateBytes)}, ${json('create_wire', LIMITS.wireBytes)}, ${json('create_receipt', LIMITS.receiptBytes)}
  ) STRICT`,
  `CREATE TABLE task_lease_guard (
    id INTEGER PRIMARY KEY CHECK (id = 1), ${json('plan_json', GUARD_BYTES - 2 * LIMITS.stateBytes - 2 * LIMITS.receiptBytes - 1024)},
    ${json('state_json', LIMITS.stateBytes)}, ${json('receipt_json', LIMITS.receiptBytes)}, ${integer('committed_at')},
    CHECK (length(CAST(plan_json || state_json || receipt_json AS BLOB)) <= ${GUARD_BYTES - 512})
  ) STRICT`,
  `CREATE TRIGGER task_lease_actor_key BEFORE UPDATE OF public_key ON task_lease_actors
    BEGIN SELECT RAISE(ABORT, 'task_lease_immutable'); END`,
  `CREATE TRIGGER task_lease_task_identity BEFORE UPDATE OF task_id, creator_key, create_wire, create_receipt ON task_lease_tasks
    BEGIN SELECT RAISE(ABORT, 'task_lease_immutable'); END`,
  `CREATE TRIGGER task_lease_task_retained BEFORE DELETE ON task_lease_tasks
    BEGIN SELECT RAISE(ABORT, 'task_lease_retained'); END`,
  `CREATE TRIGGER task_lease_actor_retained BEFORE DELETE ON task_lease_actors
    BEGIN SELECT RAISE(ABORT, 'task_lease_retained'); END`,
  `CREATE TRIGGER task_lease_insert_guard BEFORE INSERT ON task_lease_tasks
    WHEN NOT EXISTS (SELECT 1 FROM task_lease_guard WHERE id = 1 AND json_extract(plan_json, '$.taskId') = NEW.task_id)
    BEGIN SELECT RAISE(ABORT, 'task_lease_guard_required'); END`,
  `CREATE TRIGGER task_lease_state_guard BEFORE UPDATE OF state_json ON task_lease_tasks
    WHEN NOT EXISTS (SELECT 1 FROM task_lease_guard WHERE id = 1 AND json_extract(plan_json, '$.taskId') = OLD.task_id)
    BEGIN SELECT RAISE(ABORT, 'task_lease_guard_required'); END`,
  `CREATE TRIGGER task_lease_actor_ledger_guard BEFORE UPDATE OF created_tasks, actions, reserved ON task_lease_actors
    WHEN NOT EXISTS (SELECT 1 FROM task_lease_guard WHERE id = 1 AND json_extract(plan_json, '$.nextActor.public_key') = OLD.public_key)
    BEGIN SELECT RAISE(ABORT, 'task_lease_guard_required'); END`,
  `CREATE TRIGGER task_lease_service_ledger_guard BEFORE UPDATE OF revision, tasks, used_bytes ON task_lease_authority
    WHEN NOT EXISTS (SELECT 1 FROM task_lease_guard WHERE id = 1)
    BEGIN SELECT RAISE(ABORT, 'task_lease_guard_required'); END`,
];

export const authorityFields = ['origin', 'audience', 'generation', 'policy_revision', 'policy_json',
  'revision', 'clock', 'window', 'attempts_json', 'actors', 'tasks', 'used_bytes'] as const;
export const actorFields = ['public_key', 'enabled', 'created_tasks', 'actions', 'reserved'] as const;
export const taskFields = ['task_id', 'creator_key', 'state_json', 'create_wire', 'create_receipt'] as const;
export const match = (alias: string, fields: readonly string[], source: string, path: string) =>
  fields.map(k => `${alias}.${k} IS json_extract(${source}, '$.${path}${k}')`).join(' AND ');
const p = (path: string) => `json_extract(OLD.plan_json, '$.${path}')`;
// This is deliberately the last statement of every mutation batch. Any missing
// preceding write, expired proof/lease or inconsistent accounting rolls back all
// state, receipt and principal/service capacity together.
definitions.push(`CREATE TRIGGER task_lease_final_guard BEFORE DELETE ON task_lease_guard BEGIN
  SELECT CASE WHEN NOT (
    ${DB_NOW} >= OLD.committed_at AND OLD.committed_at >= ${p('observedAt')}
    AND ${DB_NOW} <= ${p('expiresAt')} AND ${DB_NOW} < ${p('proofExpiresAt')}
    AND ${p('issuedAt')} - ${DB_NOW} <= ${LIMITS.futureSkewMs}
    AND (${p('submitDeadline')} IS NULL OR ${DB_NOW} < ${p('submitDeadline')})
    AND EXISTS (SELECT 1 FROM task_lease_authority a WHERE a.id = 1
      AND ${match('a', ['origin', 'audience', 'generation', 'policy_revision', 'policy_json', 'actors'], 'OLD.plan_json', 'before.meta.')}
      AND a.revision = ${p('before.meta.revision')} + 1
      AND a.tasks = ${p('before.meta.tasks')} + ${p('creation')}
      AND a.used_bytes = ${p('before.meta.used_bytes')} + ${p('creation')} * ${TASK_BYTES}
      AND a.clock = OLD.committed_at AND a.window = ${p('windowAtCommit')} AND a.attempts_json = ${p('attemptsAtCommit')})
    AND EXISTS (SELECT 1 FROM task_lease_actors a WHERE ${match('a', actorFields, 'OLD.plan_json', 'nextActor.')})
    AND EXISTS (SELECT 1 FROM task_lease_tasks t WHERE t.task_id = ${p('taskId')}
      AND t.state_json = OLD.state_json AND t.creator_key = json_extract(OLD.state_json, '$.creatorKey')
      AND t.create_wire = CASE WHEN ${p('creation')} = 1 THEN ${p('wire')} ELSE ${p('before.task.create_wire')} END
      AND t.create_receipt = CASE WHEN ${p('creation')} = 1 THEN OLD.receipt_json ELSE ${p('before.task.create_receipt')} END)
    ) THEN RAISE(ABORT, 'task_lease_final_guard') END;
  UPDATE task_lease_authority SET clock = ${DB_NOW},
    attempts_json = CASE WHEN window = CAST(${DB_NOW} / json_extract(policy_json, '$.windowMs') AS INTEGER)
      THEN attempts_json ELSE '{"completion":0,"ordinary":0,"recovery":0}' END,
    window = CAST(${DB_NOW} / json_extract(policy_json, '$.windowMs') AS INTEGER) WHERE id = 1;
END`);

export const SCHEMA_OBJECTS = Object.freeze(definitions.map(sql => {
  const m = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/.exec(sql)!;
  return Object.freeze({ type: m[1].toLowerCase(), name: m[2], sql });
}));
export const SCHEMA_JSON = JSON.stringify(SCHEMA_OBJECTS);
