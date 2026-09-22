/** Internal request accounting, separate from membership and protected read snapshots. */
import { canonicalizeJson } from '@openagentforum/protocol';
import type { AdmissionPolicy } from './storage-types.js';
import type { RoomPacketPolicy } from './packet-storage-contract.js';

export const REQUEST_LANES = ['ordinary', 'read', 'close', 'recovery'] as const;
export type RequestLane = typeof REQUEST_LANES[number];
export const REQUEST_COUNTERS = ['requests', 'inputBytes', 'verifications', 'responseBytes'] as const;
export type RequestAllowance = { [K in typeof REQUEST_COUNTERS[number]]: number };
export type RoomRequestPolicy = { windowMs: number } & { [K in RequestLane]: RequestAllowance };
export interface RoomRequestOptions {
  hub: string;
  requests: RoomRequestPolicy;
  now: () => number;
}
export interface BudgetedRoomOptions extends RoomRequestOptions {
  policy: AdmissionPolicy;
  packets?: RoomPacketPolicy;
}
export type RequestCharge = { lane: RequestLane } & RequestAllowance;
export type RequestGateFailure = { ok: false; reason: 'storage_error' | 'busy' | 'invalid_wire' | 'invalid_public_key' }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number };
export type Reservation = { ok: true; expiresAt: number } | RequestGateFailure;
/** Operator-owned implementation only; a reservation is never a caller-visible permission token. */
export interface RequestBudget { reserve(charge: RequestCharge): Promise<Reservation> }

const MAX_TIME = Number.MAX_SAFE_INTEGER - 86_400_000;
const encoder = new TextEncoder();
export const requestBytes = (value: string) => encoder.encode(value).length;
export function requestTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIME) throw new Error('Invalid request clock');
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
}
function counters(value: unknown, minimum: number): RequestAllowance {
  if (!keys(value, REQUEST_COUNTERS)) throw new Error('Invalid request counters');
  const result = {} as RequestAllowance;
  for (const key of REQUEST_COUNTERS) {
    const n = value[key];
    const max = key === 'requests' ? 1_000_000 : key === 'verifications' ? 9_000_000 : 1_073_741_824;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < minimum || n > max || Object.is(n, -0)) throw new Error('Invalid request counters');
    result[key] = n;
  }
  return result;
}
export function requestConfiguration(options: RoomRequestOptions) {
  const url = new URL(options.hub);
  if (url.protocol !== 'https:' || url.origin !== options.hub || options.hub.length > 256 || typeof options.now !== 'function'
      || !keys(options.requests, ['windowMs', ...REQUEST_LANES])
      || !Number.isSafeInteger(options.requests.windowMs) || options.requests.windowMs < 1 || options.requests.windowMs > 86_400_000) {
    throw new Error('Invalid request budget configuration');
  }
  const policy = Object.freeze({ windowMs: options.requests.windowMs,
    ordinary: Object.freeze(counters(options.requests.ordinary, 1)), read: Object.freeze(counters(options.requests.read, 1)),
    close: Object.freeze(counters(options.requests.close, 1)), recovery: Object.freeze(counters(options.requests.recovery, 1)) });
  return Object.freeze({ hub: options.hub, now: options.now, policy, policyJson: canonicalizeJson(policy) });
}
export type RequestConfiguration = ReturnType<typeof requestConfiguration>;
type BudgetState = { clock: number; bucket: number; lanes: { [K in RequestLane]: RequestAllowance } };
const empty = (): RequestAllowance => ({ requests: 0, inputBytes: 0, verifications: 0, responseBytes: 0 });
export const initialRequestState = () => canonicalizeJson({ clock: 0, bucket: 0,
  lanes: { ordinary: empty(), read: empty(), close: empty(), recovery: empty() } });
export const REQUEST_BUDGET_SCHEMA = `CREATE TABLE IF NOT EXISTS room_lab_request_budget (
  id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  hub TEXT NOT NULL, policy TEXT NOT NULL, state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB)) <= 2048)
) STRICT`;
export const REQUEST_DB_NOW = "CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)";

export function requestState(row: Record<string, unknown> | null | undefined, config: RequestConfiguration): BudgetState {
  if (!row || row.schema_version !== 1 || row.hub !== config.hub || row.policy !== config.policyJson
      || typeof row.state_json !== 'string' || row.state_json.length > 2048 || requestBytes(row.state_json) > 2048) throw new Error('Invalid budget metadata');
  const state: unknown = JSON.parse(row.state_json);
  if (!keys(state, ['clock', 'bucket', 'lanes']) || !keys(state.lanes, REQUEST_LANES)) throw new Error('Invalid budget state');
  const clock = requestTime(state.clock), bucket = requestTime(state.bucket);
  if (bucket !== Math.floor(clock / config.policy.windowMs)) throw new Error('Invalid budget window');
  const lanes = { ordinary: counters(state.lanes.ordinary, 0), read: counters(state.lanes.read, 0),
    close: counters(state.lanes.close, 0), recovery: counters(state.lanes.recovery, 0) };
  for (const lane of REQUEST_LANES) for (const key of REQUEST_COUNTERS) {
    if (lanes[lane][key] > config.policy[lane][key]) throw new Error('Invalid retained allowance');
  }
  const result = { clock, bucket, lanes };
  if (canonicalizeJson(result) !== row.state_json) throw new Error('Noncanonical budget');
  return result;
}
export function planRequest(row: Record<string, unknown> | null | undefined, config: RequestConfiguration, charge: RequestCharge, clock: number) {
  if (!REQUEST_LANES.includes(charge.lane)) throw new Error('Invalid budget lane');
  counters(Object.fromEntries(REQUEST_COUNTERS.map(key => [key, charge[key]])), 1);
  const state = requestState(row, config);
  const now = Math.max(requestTime(clock), state.clock);
  const bucket = Math.floor(now / config.policy.windowMs);
  const expiresAt = (bucket + 1) * config.policy.windowMs;
  if (bucket > state.bucket) state.lanes = { ordinary: empty(), read: empty(), close: empty(), recovery: empty() };
  for (const key of REQUEST_COUNTERS) {
    if (state.lanes[charge.lane][key] + charge[key] > config.policy[charge.lane][key]) {
      return { ok: false as const, reason: 'rate_limited' as const, retryAfterMs: expiresAt - now };
    }
  }
  for (const key of REQUEST_COUNTERS) state.lanes[charge.lane][key] += charge[key];
  state.clock = now; state.bucket = bucket;
  return { ok: true as const, expiresAt, stateJson: canonicalizeJson(state), clock: now };
}
