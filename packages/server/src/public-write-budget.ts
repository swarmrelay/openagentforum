import { canonicalizeJson, REGISTRATION_MAX_BYTES } from '@openagentforum/protocol';
import { PUBLIC_WRITE_LIMITS } from './public-write-input.js';

/** Structural D1 surface keeps published declarations independent of dev-only Worker types. */
export interface PublicWriteBudgetStatement {
  bind(...values: unknown[]): PublicWriteBudgetStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface PublicWriteBudgetD1 {
  withSession(constraint: 'first-primary'): {
    prepare(query: string): PublicWriteBudgetStatement;
    batch(statements: PublicWriteBudgetStatement[]): Promise<{ success: boolean; results: unknown[] }[]>;
  };
}

/** Opt-in request accounting only. No public adapter mounts this candidate. */
export const PUBLIC_WRITE_COSTS = Object.freeze({
  registration: REGISTRATION_MAX_BYTES,
  channel: PUBLIC_WRITE_LIMITS.channelBytes,
  message: PUBLIC_WRITE_LIMITS.messageBytes,
  'task-create': PUBLIC_WRITE_LIMITS.taskCreateBytes,
  'task-claim': PUBLIC_WRITE_LIMITS.taskClaimBytes,
  'task-submit': PUBLIC_WRITE_LIMITS.taskSubmitBytes,
});
export type PublicWriteOperation = keyof typeof PUBLIC_WRITE_COSTS;
const operations = Object.keys(PUBLIC_WRITE_COSTS) as PublicWriteOperation[];
type Allowance = Readonly<{ requests: number; inputBytes: number }>;
export interface PublicWriteBudgetPolicy {
  windowMs: number;
  ordinary: Allowance;
  completion: Allowance;
  operations: Readonly<Record<PublicWriteOperation, number>>;
}
export interface PublicWriteBudgetOptions {
  origin: string;
  generation: string;
  policy: PublicWriteBudgetPolicy;
}
type State = { clock: number; bucket: number; ordinary: Allowance; completion: Allowance;
  operations: Record<PublicWriteOperation, number> };
export interface PublicWriteAdmission {
  /** Callback is trusted relay code, never peer code. It must retain all authorization checks. */
  run<T>(request: Request, operation: PublicWriteOperation, work: () => Promise<T>): Promise<T>;
}
const stateBytes = 2048;
const policyBytes = 2048;
const reservationMs = 5000;
const maxInFlight = 8;
const maxTime = Number.MAX_SAFE_INTEGER - 86_400_000;
const encoder = new TextEncoder();
const errorStatuses = { public_write_rate_limited: 429, public_write_budget_busy: 503,
  public_write_budget_unavailable: 503, invalid_public_write_operation: 400 } as const;
export class PublicWriteBudgetError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errorStatuses, readonly retryAfterMs?: number) {
    super(code); this.name = 'PublicWriteBudgetError'; this.status = errorStatuses[code];
  }
  getResponse(): Response {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    if (this.code === 'public_write_rate_limited' && this.retryAfterMs !== undefined && Number.isFinite(this.retryAfterMs)) {
      headers.set('Retry-After', String(Math.min(86_400, Math.max(1, Math.ceil(this.retryAfterMs / 1000)))));
    }
    return new Response(JSON.stringify({ error: this.code, code: this.code }), { status: this.status, headers });
  }
}
const unavailable = () => new PublicWriteBudgetError('public_write_budget_unavailable');
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
}
function number(value: unknown, max: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) throw unavailable();
  return value;
}
function allowance(value: unknown, min: number): Allowance {
  if (!keys(value, ['requests', 'inputBytes'])) throw unavailable();
  return Object.freeze({ requests: number(value.requests, 1_000_000, min), inputBytes: number(value.inputBytes, 1_073_741_824, min) });
}
function operationCounts(value: unknown, min: number): Record<PublicWriteOperation, number> {
  if (!keys(value, operations)) throw unavailable();
  return Object.fromEntries(operations.map(op => [op, number(value[op], 1_000_000, min)])) as Record<PublicWriteOperation, number>;
}
export function publicWriteBudgetConfiguration(options: PublicWriteBudgetOptions) {
  try {
    if (!keys(options, ['origin', 'generation', 'policy']) || typeof options.origin !== 'string'
      || options.origin.length > 256 || new URL(options.origin).origin !== options.origin || !options.origin.startsWith('https://')
      || typeof options.generation !== 'string' || !/^[0-9a-f]{64}$/.test(options.generation)
      || !keys(options.policy, ['windowMs', 'ordinary', 'completion', 'operations'])) throw unavailable();
    const policy = Object.freeze({ windowMs: number(options.policy.windowMs, 86_400_000, 1),
      ordinary: allowance(options.policy.ordinary, 1), completion: allowance(options.policy.completion, 1),
      operations: Object.freeze(operationCounts(options.policy.operations, 1)) });
    for (const op of operations) {
      const lane = op === 'task-submit' ? 'completion' : 'ordinary';
      if (policy[lane].inputBytes < PUBLIC_WRITE_COSTS[op] || policy.operations[op] > policy[lane].requests) throw unavailable();
    }
    const policyJson = canonicalizeJson(policy);
    if (encoder.encode(policyJson).length > policyBytes) throw unavailable();
    return Object.freeze({ origin: options.origin, generation: options.generation, policy, policyJson });
  } catch { throw new Error('Invalid public write budget configuration'); }
}
export type PublicWriteBudgetConfiguration = ReturnType<typeof publicWriteBudgetConfiguration>;
export const PUBLIC_WRITE_BUDGET_SCHEMA = `CREATE TABLE public_write_request_budget (
  id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  origin TEXT NOT NULL CHECK(length(CAST(origin AS BLOB)) <= 256),
  generation TEXT NOT NULL CHECK(length(generation) = 64),
  policy TEXT NOT NULL CHECK(length(CAST(policy AS BLOB)) <= ${policyBytes}),
  state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB)) <= ${stateBytes})
) STRICT`;
export const PUBLIC_WRITE_BUDGET_DB_NOW = "CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)";
// Bounded projections also fail closed if a fixture/operator damaged the schema constraints.
export const PUBLIC_WRITE_BUDGET_READ = `SELECT schema_version,
  CASE WHEN length(CAST(origin AS BLOB)) <= 256 THEN origin END AS origin,
  CASE WHEN length(generation) = 64 THEN generation END AS generation,
  CASE WHEN length(CAST(policy AS BLOB)) <= ${policyBytes} THEN policy END AS policy,
  CASE WHEN length(CAST(state_json AS BLOB)) <= ${stateBytes} THEN state_json END AS state_json,
  ${PUBLIC_WRITE_BUDGET_DB_NOW} AS db_now FROM public_write_request_budget WHERE id = 1`;
export const PUBLIC_WRITE_BUDGET_CAS = `UPDATE public_write_request_budget SET state_json = ?1
  WHERE id = 1 AND schema_version = 1 AND origin = ?2 AND generation = ?3 AND policy = ?4 AND state_json = ?5
    AND ${PUBLIC_WRITE_BUDGET_DB_NOW} >= ?6 AND ${PUBLIC_WRITE_BUDGET_DB_NOW} < ?7
  RETURNING state_json, ${PUBLIC_WRITE_BUDGET_DB_NOW} AS db_now`;

/** Pure provisioning data; callers must explicitly create/seed a dedicated test database. Never refill on request. */
export function publicWriteBudgetSeed(options: PublicWriteBudgetOptions) {
  const config = publicWriteBudgetConfiguration(options);
  const empty = () => ({ requests: 0, inputBytes: 0 });
  return Object.freeze({ origin: config.origin, generation: config.generation, policy: config.policyJson,
    state: canonicalizeJson({ clock: 0, bucket: 0, ordinary: empty(), completion: empty(),
      operations: Object.fromEntries(operations.map(op => [op, 0])) }) });
}
export function planPublicWriteCharge(row: Record<string, unknown> | null | undefined, config: PublicWriteBudgetConfiguration, operation: PublicWriteOperation) {
  if (!Object.hasOwn(PUBLIC_WRITE_COSTS, operation) || !row || row.schema_version !== 1 || row.origin !== config.origin
    || row.generation !== config.generation || row.policy !== config.policyJson || typeof row.state_json !== 'string'
    || encoder.encode(row.state_json).length > stateBytes) throw unavailable();
  const raw: unknown = JSON.parse(row.state_json);
  if (!keys(raw, ['clock', 'bucket', 'ordinary', 'completion', 'operations'])) throw unavailable();
  const state: State = { clock: number(raw.clock, maxTime), bucket: number(raw.bucket, maxTime),
    ordinary: allowance(raw.ordinary, 0), completion: allowance(raw.completion, 0), operations: operationCounts(raw.operations, 0) };
  if (state.bucket !== Math.floor(state.clock / config.policy.windowMs) || canonicalizeJson(state) !== row.state_json) throw unavailable();
  for (const lane of ['ordinary', 'completion'] as const) for (const counter of ['requests', 'inputBytes'] as const) {
    if (state[lane][counter] > config.policy[lane][counter]) throw unavailable();
  }
  for (const op of operations) if (state.operations[op] > config.policy.operations[op]) throw unavailable();
  // Cross-check the redundant counters; corruption cannot manufacture allowance.
  for (const lane of ['ordinary', 'completion'] as const) {
    const members = operations.filter(op => (op === 'task-submit' ? 'completion' : 'ordinary') === lane);
    if (members.reduce((sum, op) => sum + state.operations[op], 0) !== state[lane].requests
      || members.reduce((sum, op) => sum + state.operations[op] * PUBLIC_WRITE_COSTS[op], 0) !== state[lane].inputBytes) throw unavailable();
  }
  const now = number(row.db_now, maxTime);
  if (now < state.clock) throw unavailable();
  const bucket = Math.floor(now / config.policy.windowMs), expiresAt = (bucket + 1) * config.policy.windowMs;
  if (bucket > state.bucket) {
    state.ordinary = { requests: 0, inputBytes: 0 }; state.completion = { requests: 0, inputBytes: 0 };
    for (const op of operations) state.operations[op] = 0;
  }
  const lane = operation === 'task-submit' ? 'completion' : 'ordinary';
  if (state[lane].requests + 1 > config.policy[lane].requests
    || state[lane].inputBytes + PUBLIC_WRITE_COSTS[operation] > config.policy[lane].inputBytes
    || state.operations[operation] + 1 > config.policy.operations[operation]) {
    throw new PublicWriteBudgetError('public_write_rate_limited', expiresAt - now);
  }
  state[lane] = { requests: state[lane].requests + 1, inputBytes: state[lane].inputBytes + PUBLIC_WRITE_COSTS[operation] };
  state.operations[operation]++; state.clock = now; state.bucket = bucket;
  return { stateJson: canonicalizeJson(state), clock: now, expiresAt };
}
type Grant = { validUntil: number };
type Reserve = (operation: PublicWriteOperation, active: () => void) => Promise<Grant>;
/** Internal composition: no public reservation token, refunds, request retries or caller-defined costs. */
export function publicWriteAdmission(reserve: Reserve): PublicWriteAdmission {
  let inFlight = 0, poisoned = false;
  return Object.freeze({ async run<T>(request: Request, operation: PublicWriteOperation, work: () => Promise<T>): Promise<T> {
    let started = false, counted = false, timer: ReturnType<typeof setTimeout> | undefined, expired = false;
    let onAbort: (() => void) | undefined;
    try {
      if (request.method !== 'POST' || request.signal.aborted || !Object.hasOwn(PUBLIC_WRITE_COSTS, operation)) {
        throw new PublicWriteBudgetError('invalid_public_write_operation');
      }
      if (poisoned) throw unavailable();
      if (inFlight >= maxInFlight) throw new PublicWriteBudgetError('public_write_budget_busy');
      inFlight++; counted = true;
      const deadline = performance.now() + reservationMs;
      // Timers cannot interrupt synchronous SQLite or a blocked event loop.
      const active = () => {
        if (expired || poisoned || request.signal.aborted || performance.now() >= deadline) throw unavailable();
      };
      let grant: Grant;
      try {
        // Install the abort listener before starting storage, including synchronous adapters.
        const interrupted = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(unavailable()); }, reservationMs);
          onAbort = () => { expired = true; reject(unavailable()); };
          request.signal.addEventListener('abort', onAbort, { once: true });
        });
        grant = await Promise.race([interrupted, reserve(operation, active)]);
        active();
        if (!Number.isFinite(grant.validUntil)) throw unavailable();
        if (performance.now() >= grant.validUntil) throw new PublicWriteBudgetError('public_write_budget_busy');
      } catch (error) {
        if (error instanceof PublicWriteBudgetError && (error.code === 'public_write_rate_limited' || error.code === 'public_write_budget_busy')) throw error;
        poisoned = true; throw unavailable();
      } finally {
        clearTimeout(timer);
        if (onAbort) request.signal.removeEventListener('abort', onAbort);
      }
      started = true;
      const result = await work();
      if (poisoned) throw unavailable();
      return result;
    } finally {
      clearTimeout(timer);
      if (onAbort) request.signal.removeEventListener('abort', onAbort);
      if (counted) inFlight--;
      if (!started && request.body && !request.body.locked) void request.body.cancel().catch(() => {});
    }
  } });
}

/** Operator-owned database and policy only. Constructors do no I/O and never seed authority. */
export function createD1PublicWriteAdmission(db: PublicWriteBudgetD1, options: PublicWriteBudgetOptions): PublicWriteAdmission {
  const config = publicWriteBudgetConfiguration(options);
  return publicWriteAdmission(async (operation, active) => {
    let firstExpiry: number | undefined, highWater = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      active();
      const started = performance.now();
      const row = await db.withSession('first-primary').prepare(PUBLIC_WRITE_BUDGET_READ).first<Record<string, unknown>>();
      active();
      // A failed CAS must not allow the next read to forget an observed clock.
      if (!row || number(row.db_now, maxTime) < highWater) throw unavailable();
      highWater = Number(row.db_now);
      const plan = planPublicWriteCharge(row, config, operation);
      if (firstExpiry !== undefined && firstExpiry !== plan.expiresAt) throw new PublicWriteBudgetError('public_write_budget_busy');
      firstExpiry = plan.expiresAt;
      const validUntil = started + plan.expiresAt - plan.clock;
      if (performance.now() >= validUntil) throw new PublicWriteBudgetError('public_write_budget_busy');
      const session = db.withSession('first-primary');
      const result = await session.batch([session.prepare(PUBLIC_WRITE_BUDGET_CAS)
        .bind(plan.stateJson, config.origin, config.generation, config.policyJson, row.state_json, plan.clock, plan.expiresAt)]);
      active();
      if (result.length !== 1 || result[0].success !== true || !Array.isArray(result[0].results)) throw unavailable();
      // Retry only an acknowledged zero-row CAS, never an uncertain/charged attempt or application work.
      if (result[0].results.length === 0) continue;
      const committed = result[0].results[0];
      if (result[0].results.length !== 1 || !record(committed) || committed.state_json !== plan.stateJson
        || number(committed.db_now, maxTime) < plan.clock || Number(committed.db_now) >= plan.expiresAt) throw unavailable();
      return { validUntil };
    }
    throw new PublicWriteBudgetError('public_write_budget_busy');
  });
}
