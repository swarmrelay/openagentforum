import { canonicalizeJson } from '@openagentforum/protocol';
import { PROFILE, LIMITS, TASK_BYTES, FIXED_BYTES, GUARD_BYTES, need, integer, hex, taskId, object, keys, bytes,
  configuration, validate, bounded, initial, decide, fresh, makeReceipt, type State, type Proof, type Receipt, type Options } from './contract.js';

export type Raw = Record<string, unknown>;
export interface Actor { public_key: string; enabled: number; created_tasks: number; actions: number; reserved: number }
export interface Authority {
  origin: string; audience: string; generation: string; policy_revision: string; policy_json: string;
  revision: number; clock: number; window: number; attempts_json: string; actors: number; tasks: number; used_bytes: number;
}
export interface TaskRow { task_id: string; creator_key: string; state_json: string; create_wire: string; create_receipt: string }
export interface Snapshot { meta: Authority; actor: Actor | null; task: TaskRow | null; state: State | null; now: number }
export const blankAttempts = () => ({ ordinary: 0, completion: 0, recovery: 0 });
function number(value: unknown): number { need(integer(value), 'authority'); return value; }
export function authority(value: unknown, config: ReturnType<typeof configuration>): Authority {
  need(object(value), 'authority');
  need(value.origin === config.origin && value.audience === config.audience && value.generation === config.generation
    && value.policy_revision === config.policyRevision && value.policy_json === config.policyJson, 'authority');
  for (const name of ['revision', 'clock', 'window', 'actors', 'tasks', 'used_bytes']) need(integer(value[name]), 'authority');
  need(Number(value.actors) <= config.policy.maxActors && Number(value.tasks) <= config.policy.maxTasks
    && value.used_bytes === (2 + Number(value.actors)) * FIXED_BYTES + GUARD_BYTES + Number(value.tasks) * TASK_BYTES
    && Number(value.used_bytes) <= config.policy.maxBytes, 'authority');
  need(typeof value.attempts_json === 'string' && bytes(value.attempts_json) <= 256, 'authority');
  let attempts: unknown; try { attempts = JSON.parse(value.attempts_json); } catch { need(false, 'authority'); }
  need(object(attempts) && Object.keys(attempts).length === 3 && canonicalizeJson(attempts) === value.attempts_json, 'authority');
  for (const lane of ['ordinary', 'completion', 'recovery'] as const) {
    need(integer(attempts[lane]) && attempts[lane] <= config.policy.attempts[lane], 'authority');
  }
  return { origin: config.origin, audience: config.audience, generation: config.generation, policy_revision: config.policyRevision,
    policy_json: config.policyJson, revision: number(value.revision), clock: number(value.clock), window: number(value.window),
    attempts_json: value.attempts_json, actors: number(value.actors), tasks: number(value.tasks), used_bytes: number(value.used_bytes) };
}
export function actor(value: unknown, policy: Options['policy']): Actor | null {
  if (value === null) return null;
  need(object(value) && hex(value.public_key, 64) && (value.enabled === 0 || value.enabled === 1), 'authority');
  for (const field of ['created_tasks', 'actions', 'reserved']) need(integer(value[field]), 'authority');
  need(Number(value.created_tasks) <= policy.creatorTasks && Number(value.actions) + Number(value.reserved) <= policy.actorActions, 'authority');
  return { public_key: value.public_key, enabled: value.enabled, created_tasks: number(value.created_tasks),
    actions: number(value.actions), reserved: number(value.reserved) };
}
export function receipt(value: unknown, state: Pick<State, 'audience' | 'taskId'>): Receipt {
  need(object(value), 'authority');
  need(Object.keys(value).sort().join(',') === 'action,actorKey,audience,commandDigest,committedAt,generation,leaseExpiresAt,operationId,profile,resolutionDigest,resultDigest,revision,status,taskId'
    && value.profile === PROFILE && value.audience === state.audience && value.taskId === state.taskId
    && hex(value.actorKey, 64) && hex(value.operationId, 32) && hex(value.commandDigest, 64)
    && (value.action === 'create' || value.action === 'claim' || value.action === 'submit' || value.action === 'release' || value.action === 'reopen')
    && (value.status === 'open' || value.status === 'claimed' || value.status === 'reconciliation' || value.status === 'completed')
    && integer(value.revision) && integer(value.generation) && integer(value.committedAt)
    && (value.leaseExpiresAt === null || integer(value.leaseExpiresAt))
    && (value.resultDigest === null || hex(value.resultDigest, 64))
    && (value.resolutionDigest === null || hex(value.resolutionDigest, 64))
    && bytes(canonicalizeJson(value)) <= LIMITS.receiptBytes, 'authority');
  return { profile: PROFILE, audience: state.audience, taskId: state.taskId, actorKey: value.actorKey, operationId: value.operationId,
    commandDigest: value.commandDigest, action: value.action, revision: value.revision, generation: value.generation,
    status: value.status, committedAt: value.committedAt, leaseExpiresAt: value.leaseExpiresAt,
    resultDigest: value.resultDigest, resolutionDigest: value.resolutionDigest };
}
export function state(raw: string, row: Pick<TaskRow, 'task_id' | 'creator_key'>, audience: string): State {
  try {
    need(typeof raw === 'string' && bytes(raw) <= LIMITS.stateBytes, 'authority');
    const value: unknown = JSON.parse(raw);
    keys(value, ['profile', 'audience', 'taskId', 'creatorKey', 'timeoutMs', 'reassignment', 'content', 'revision', 'generation', 'status', 'lease', 'result', 'updatedAt', 'receipts']);
    need(value.profile === PROFILE && value.audience === audience && value.taskId === row.task_id
      && taskId(value.taskId) && value.creatorKey === row.creator_key && hex(value.creatorKey, 64), 'authority');
    need(integer(value.revision) && value.revision <= LIMITS.receipts && integer(value.generation)
      && value.generation <= value.revision && integer(value.updatedAt), 'authority');
    need(object(value.content), 'authority');
    const creation = { profile: PROFILE, audience, actorKey: value.creatorKey, operationId: '00'.repeat(16), issuedAt: 0, expiresAt: 1,
      taskId: null, expectedRevision: null, action: 'create', payload: { ...value.content, timeoutMs: value.timeoutMs, reassignment: value.reassignment } };
    validate(creation); need(creation.action === 'create', 'authority');
    const { timeoutMs, reassignment, ...content } = creation.payload;
    need(value.status === 'open' || value.status === 'claimed' || value.status === 'reconciliation' || value.status === 'completed', 'authority');
    let parsedLease: State['lease'] = null;
    if (value.status === 'open') need(value.lease === null, 'authority');
    else {
      const lease = value.lease; keys(lease, ['holderKey', 'generation', 'claimedAt', 'expiresAt']);
      need(hex(lease.holderKey, 64) && lease.generation === value.generation && value.generation > 0
        && integer(lease.claimedAt) && integer(lease.expiresAt) && lease.expiresAt === lease.claimedAt + Number(value.timeoutMs)
        && lease.claimedAt <= value.updatedAt, 'authority');
      parsedLease = { holderKey: lease.holderKey, generation: value.generation, claimedAt: lease.claimedAt, expiresAt: lease.expiresAt };
    }
    let parsedResult: State['result'] = null;
    if (value.status === 'completed') {
      const result = value.result; keys(result, ['canonicalPayload', 'digest']);
      need(typeof result.canonicalPayload === 'string' && bytes(result.canonicalPayload) <= LIMITS.resultBytes && hex(result.digest, 64), 'authority');
      const parsed: unknown = JSON.parse(result.canonicalPayload); bounded(parsed);
      need(canonicalizeJson(parsed) === result.canonicalPayload, 'authority');
      parsedResult = { canonicalPayload: result.canonicalPayload, digest: result.digest };
    } else need(value.result === null, 'authority');
    need(Array.isArray(value.receipts) && value.receipts.length === value.revision, 'authority');
    const receipts: Receipt[] = [], seen = new Set<string>(); let generation = 0, clock = 0;
    for (let i = 0; i < value.receipts.length; i++) {
      const r = receipt(value.receipts[i], { audience, taskId: row.task_id });
      need(r.action !== 'create' && r.revision === i + 1 && r.committedAt >= clock && r.committedAt <= value.updatedAt
        && r.generation === generation + (r.action === 'claim' ? 1 : 0), 'authority');
      const id = `${r.actorKey}:${r.operationId}`; need(!seen.has(id), 'authority'); seen.add(id);
      generation = r.generation; clock = r.committedAt; receipts.push(r);
    }
    const last = receipts.at(-1);
    need(generation === value.generation && (last ? last.status === value.status && last.committedAt === value.updatedAt
      && last.leaseExpiresAt === (object(value.lease) ? value.lease.expiresAt : null) : value.status === 'open'), 'authority');
    if (value.status === 'completed') need(last?.action === 'submit' && object(value.result) && last.resultDigest === value.result.digest, 'authority');
    need(canonicalizeJson(value) === raw, 'authority');
    return { profile: PROFILE, audience, taskId: value.taskId, creatorKey: value.creatorKey, timeoutMs, reassignment, content,
      revision: value.revision, generation: value.generation, status: value.status, lease: parsedLease, result: parsedResult,
      updatedAt: value.updatedAt, receipts };
  } catch { need(false, 'authority'); }
}
export function task(value: unknown, audience: string): { row: TaskRow; state: State } | null {
  if (value === null) return null;
  need(object(value) && taskId(value.task_id) && hex(value.creator_key, 64)
    && typeof value.state_json === 'string' && typeof value.create_wire === 'string' && bytes(value.create_wire) <= LIMITS.wireBytes
    && typeof value.create_receipt === 'string' && bytes(value.create_receipt) <= LIMITS.receiptBytes, 'authority');
  const row: TaskRow = { task_id: value.task_id, creator_key: value.creator_key, state_json: value.state_json,
    create_wire: value.create_wire, create_receipt: value.create_receipt }, parsed = state(row.state_json, row, audience);
  const creation = receipt(JSON.parse(row.create_receipt), parsed);
  need(creation.action === 'create' && creation.actorKey === parsed.creatorKey && creation.taskId === 'task_' + creation.commandDigest
    && creation.revision === 0 && creation.generation === 0 && creation.status === 'open' && creation.leaseExpiresAt === null
    && creation.resultDigest === null && creation.resolutionDigest === null && creation.committedAt <= parsed.updatedAt, 'authority');
  return { row, state: parsed };
}
export function existing(snapshot: Snapshot, proof: Proof): Receipt | null {
  if (!snapshot.task || !snapshot.state) return null;
  const c = proof.command, key = c.action === 'receipt' ? c.payload.operationId : c.operationId;
  const digest = c.action === 'receipt' ? c.payload.commandDigest : proof.digest;
  const all = [receipt(JSON.parse(snapshot.task.create_receipt), snapshot.state), ...snapshot.state.receipts];
  const r = all.find(r => r.actorKey === c.actorKey && r.operationId === key);
  if (!r) return null;
  if (c.action === 'receipt') return r.commandDigest === digest ? r : null;
  need(r.commandDigest === digest, 'operation_conflict'); return r;
}
export function plan(snapshot: Snapshot, proof: Proof, config: ReturnType<typeof configuration>) {
  const c = proof.command, a = snapshot.actor; fresh(proof, config.audience, snapshot.now);
  need(a?.enabled === 1 && a.public_key === c.actorKey, 'scope');
  need(c.action !== 'receipt', 'route');
  const replay = existing(snapshot, proof); if (replay) return { replay };
  const creation = c.action === 'create', terminal = c.action === 'submit' || c.action === 'release';
  let nextState: State;
  if (creation) { need(!snapshot.task, 'operation_conflict'); nextState = initial(proof, snapshot.now); }
  else { need(snapshot.state, 'scope'); nextState = decide(snapshot.state, proof, snapshot.now); }
  const nextActor = { ...a };
  if (terminal) { need(a.reserved > 0, 'authority'); nextActor.reserved--; }
  else if (c.action === 'claim') nextActor.reserved++;
  nextActor.actions++; need(nextActor.actions + nextActor.reserved <= config.policy.actorActions, 'capacity');
  if (creation) {
    nextActor.created_tasks++;
    need(snapshot.meta.tasks < config.policy.maxTasks && snapshot.meta.used_bytes + TASK_BYTES <= config.policy.maxBytes
      && nextActor.created_tasks <= config.policy.creatorTasks, 'capacity');
  }
  const nextReceipt = creation ? makeReceipt(nextState, proof, snapshot.now) : nextState.receipts.at(-1)!;
  need(bytes(canonicalizeJson(nextState)) <= LIMITS.stateBytes && bytes(canonicalizeJson(nextReceipt)) <= LIMITS.receiptBytes, 'capacity');
  need(snapshot.meta.revision < Number.MAX_SAFE_INTEGER, 'capacity');
  return { creation, nextActor, nextState, nextReceipt, replay: null };
}
