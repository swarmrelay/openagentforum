import { LIMITS, TASK_BYTES } from './contract.js';
import { DB_NOW, SCHEMA_OBJECTS, authorityFields, actorFields, taskFields, match } from './schema.js';

const input = 'input AS (SELECT ? AS schema_json, ? AS request_json)';
const schemaOk = `(SELECT count(*) FROM (SELECT 1 FROM sqlite_schema WHERE sql IS NOT NULL
    AND name NOT GLOB 'sqlite_*' AND NOT (type = 'table' AND name IN ('_cf_KV', '_cf_METADATA'))
    LIMIT ${SCHEMA_OBJECTS.length + 1})) = ${SCHEMA_OBJECTS.length}
  AND NOT EXISTS (SELECT 1 FROM json_each(i.schema_json) e LEFT JOIN sqlite_schema s ON s.name = json_extract(e.value, '$.name')
    WHERE s.type IS NOT json_extract(e.value, '$.type') OR s.sql IS NOT json_extract(e.value, '$.sql'))`;
const checked = `checked AS MATERIALIZED (SELECT (${schemaOk}) AS schema_ok FROM input i)`;
const meta = `meta AS MATERIALIZED (SELECT a.*, ${DB_NOW} AS db_now, c.schema_ok,
  NOT EXISTS (SELECT 1 FROM task_lease_guard WHERE id = 1) AS guard_empty FROM task_lease_authority a, checked c WHERE a.id = 1)`;
const field = (path: string, source = 'i.request_json') => `json_extract(${source}, '$.${path}')`;
const row = (alias: string, fields: readonly string[]) => `json_object(${fields.map(k => `'${k}', ${alias}.${k}`).join(', ')})`;
export const META_SQL = `WITH ${input}, ${checked}, ${meta} SELECT * FROM meta`;
export const SNAPSHOT_SQL = `WITH ${input}, ${checked}, ${meta},
  ready AS MATERIALIZED (SELECT * FROM meta WHERE schema_ok = 1 AND guard_empty = 1)
  SELECT 'meta' AS kind, ${row('m', [...authorityFields, 'db_now', 'schema_ok', 'guard_empty'])} AS body FROM meta m
  UNION ALL SELECT 'actor', ${row('a', actorFields)} FROM task_lease_actors a, input i, ready
    WHERE a.public_key = ${field('actor')}
  UNION ALL SELECT 'task', ${row('t', taskFields)} FROM task_lease_tasks t, input i, ready
    WHERE t.task_id = ${field('taskId')}`;

/** Single durable attempt CAS, before reading/parsing/verifying the command. */
export const CHARGE_SQL = `WITH ${input}, ${checked}
  UPDATE task_lease_authority AS a SET clock = ${DB_NOW}, window = ${field('window', '(SELECT request_json FROM input)')},
    attempts_json = ${field('attempts', '(SELECT request_json FROM input)')}
  WHERE a.id = 1 AND EXISTS (SELECT 1 FROM input i, checked c WHERE c.schema_ok = 1
    AND ${match('a', authorityFields, 'i.request_json', 'meta.')}
    AND ${DB_NOW} >= a.clock AND ${DB_NOW} >= ${field('observedAt')}
    AND ${DB_NOW} <= ${field('expiresAt')}
    AND CAST(${DB_NOW} / json_extract(a.policy_json, '$.windowMs') AS INTEGER) = ${field('window')})
    AND NOT EXISTS (SELECT 1 FROM task_lease_guard WHERE id = 1)
  RETURNING clock`;

export const STAGE_SQL = `WITH ${input}, ${checked}
  INSERT INTO task_lease_guard (id, plan_json, state_json, receipt_json, committed_at)
  SELECT 1, json_set(json_remove(i.request_json, '$.nextState', '$.nextReceipt'),
    '$.windowAtCommit', a.window, '$.attemptsAtCommit', a.attempts_json), ${field('nextState')}, ${field('nextReceipt')}, ${DB_NOW}
  FROM input i, checked c, task_lease_authority a, task_lease_actors actor
  LEFT JOIN task_lease_tasks t ON t.task_id = ${field('taskId')}
  WHERE a.id = 1 AND c.schema_ok = 1
    AND ${match('a', ['origin', 'audience', 'generation', 'policy_revision', 'policy_json', 'revision', 'actors', 'tasks', 'used_bytes'], 'i.request_json', 'before.meta.')}
    AND ${match('actor', actorFields, 'i.request_json', 'before.actor.')}
    AND ((${field('creation')} = 1 AND t.task_id IS NULL) OR (${field('creation')} = 0
      AND ${match('t', taskFields, 'i.request_json', 'before.task.')}))
    AND NOT EXISTS (SELECT 1 FROM task_lease_guard WHERE id = 1)
    AND ${DB_NOW} >= a.clock AND ${DB_NOW} >= ${field('observedAt')}
    AND ${DB_NOW} <= ${field('expiresAt')} AND ${DB_NOW} < ${field('proofExpiresAt')}
    AND ${field('issuedAt')} - ${DB_NOW} <= ${LIMITS.futureSkewMs}
    AND (${field('submitDeadline')} IS NULL OR ${DB_NOW} < ${field('submitDeadline')})
    AND (${field('reclaimAfter')} IS NULL OR ${DB_NOW} >= ${field('reclaimAfter')})`;

export const FINALIZE_RECEIPT_SQL = `UPDATE task_lease_guard SET receipt_json = json_set(receipt_json,
  '$.committedAt', committed_at, '$.leaseExpiresAt', CASE WHEN json_extract(plan_json, '$.action') = 'claim'
    THEN committed_at + json_extract(state_json, '$.timeoutMs') ELSE json_extract(receipt_json, '$.leaseExpiresAt') END) WHERE id = 1`;
export const FINALIZE_STATE_SQL = `UPDATE task_lease_guard SET state_json = CASE
  WHEN json_extract(plan_json, '$.action') = 'create' THEN json_set(state_json, '$.updatedAt', committed_at)
  WHEN json_extract(plan_json, '$.action') = 'claim' THEN json_set(state_json, '$.updatedAt', committed_at,
    '$.lease.claimedAt', committed_at, '$.lease.expiresAt', json_extract(receipt_json, '$.leaseExpiresAt'),
    '$.receipts[#-1]', json(receipt_json))
  ELSE json_set(state_json, '$.updatedAt', committed_at, '$.receipts[#-1]', json(receipt_json)) END WHERE id = 1`;
const admitted = '(SELECT plan_json FROM task_lease_guard WHERE id = 1)';
export const INSERT_TASK_SQL = `INSERT INTO task_lease_tasks (task_id, creator_key, state_json, create_wire, create_receipt)
  SELECT json_extract(plan_json, '$.taskId'), json_extract(state_json, '$.creatorKey'), state_json,
    json_extract(plan_json, '$.wire'), receipt_json FROM task_lease_guard WHERE id = 1 AND json_extract(plan_json, '$.creation') = 1`;
export const UPDATE_TASK_SQL = `UPDATE task_lease_tasks SET state_json = (SELECT state_json FROM task_lease_guard WHERE id = 1)
  WHERE task_id = ${field('taskId', admitted)} AND ${field('creation', admitted)} = 0
    AND state_json = ${field('before.task.state_json', admitted)}`;
export const UPDATE_ACTOR_SQL = `UPDATE task_lease_actors SET created_tasks = ${field('nextActor.created_tasks', admitted)},
  actions = ${field('nextActor.actions', admitted)}, reserved = ${field('nextActor.reserved', admitted)}
  WHERE public_key = ${field('nextActor.public_key', admitted)} AND ${match('task_lease_actors', actorFields, admitted, 'before.actor.')}`;
export const UPDATE_META_SQL = `UPDATE task_lease_authority SET revision = revision + 1,
  tasks = tasks + ${field('creation', admitted)}, used_bytes = used_bytes + ${field('creation', admitted)} * ${TASK_BYTES},
  clock = (SELECT committed_at FROM task_lease_guard WHERE id = 1)
  WHERE id = 1 AND revision = ${field('before.meta.revision', admitted)}`;
export const READ_RESULT_SQL = 'SELECT receipt_json FROM task_lease_guard WHERE id = 1';
export const FINAL_SQL = `DELETE FROM task_lease_guard WHERE id = 1 RETURNING id, ${DB_NOW} AS db_now`;
export const MUTATION_SQL = [FINALIZE_RECEIPT_SQL, FINALIZE_STATE_SQL, INSERT_TASK_SQL, UPDATE_TASK_SQL,
  UPDATE_ACTOR_SQL, UPDATE_META_SQL, READ_RESULT_SQL, FINAL_SQL] as const;
