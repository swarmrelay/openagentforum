/** Unmounted Pages/D1 integration for #162/#295. No public route imports this file. */
import type { D1Database } from '@cloudflare/workers-types';
import { createBudgetedD1RoomStore } from '../../../../packages/room-admission/src/d1-request-gate.js';
import type { BudgetedRoomOptions } from '../../../../packages/room-admission/src/request-budget.js';
import { requestBytes, requestConfiguration } from '../../../../packages/room-admission/src/request-budget.js';
import { policySnapshot } from '../../../../packages/room-admission/src/storage-contract.js';
import { packetPolicySnapshot } from '../../../../packages/room-admission/src/packet-storage-contract.js';
import { ROOM_HTTP_PATHS, ROOM_HTTP_KEY_HEADER, RoomBodyError, cancelRoomBody, roomDeadline, roomWithSignal,
  readRoomBody, roomHttpOrigin, roomHttpHasKey, roomHttpRequestBytes, roomHttpResponseBytes,
  type RoomHttpOperation } from '../../../../packages/room-admission/src/http-contract.js';

export interface PrivateRoomHttpConfiguration extends Omit<BudgetedRoomOptions, 'now' | 'packets'> {
  packets: NonNullable<BudgetedRoomOptions['packets']>;
  bodyTimeoutMs: number;
  operationTimeoutMs: number;
}
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'vary': 'Origin' };
function error(status: number, code: string, retryAfter?: number) {
  return new Response(JSON.stringify({ ok: false, error: code }), { status, headers: {
    ...headers, ...(status === 405 ? { allow: 'POST' } : {}), ...(retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }),
  } });
}

/** Operator configuration only. No request body, URL or header selects policy, clock or database. */
export async function onRequestPrivateRoom(request: Request, db: D1Database | undefined,
  configuration?: PrivateRoomHttpConfiguration): Promise<Response> {
  let operation: RoomHttpOperation;
  let key: string | undefined;
  let config: PrivateRoomHttpConfiguration;
  const reject = (status: number, code: string, retry?: number) => { cancelRoomBody(request.body); return error(status, code, retry); };
  try {
    if (!db || !configuration || !configuration.packets) return reject(503, 'room_unavailable', 60);
    const hub = roomHttpOrigin(configuration.hub);
    for (const [value, max] of [[configuration.bodyTimeoutMs, 5000], [configuration.operationTimeoutMs, 15000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) return reject(503, 'room_unavailable', 60);
    }
    // Snapshot operator options once, before any await; no policy drift mid-body.
    config = Object.freeze({ hub, policy: policySnapshot(configuration.policy), packets: packetPolicySnapshot(configuration.packets),
      requests: requestConfiguration({ ...configuration, now: Date.now }).policy,
      bodyTimeoutMs: configuration.bodyTimeoutMs, operationTimeoutMs: configuration.operationTimeoutMs });
    const url = new URL(request.url);
    const selected = Object.entries(ROOM_HTTP_PATHS).find(([, path]) => path === url.pathname);
    if (!selected || url.origin !== hub || url.search || url.hash) return reject(404, 'room_unavailable');
    operation = selected[0] as RoomHttpOperation;
    if (request.method !== 'POST') return reject(405, 'method_not_allowed');
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== hub) return reject(403, 'origin_not_allowed');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
      || ![null, 'identity'].includes(request.headers.get('content-encoding'))) return reject(415, 'unsupported_media_type');
    const length = request.headers.get('content-length');
    if (length !== null && (!/^(0|[1-9][0-9]{0,8})$/.test(length) || Number(length) > roomHttpRequestBytes(operation))) {
      return reject(413, 'request_too_large');
    }
    key = request.headers.get(ROOM_HTTP_KEY_HEADER) ?? undefined;
    if (roomHttpHasKey(operation) ? !key || !/^[0-9a-f]{64}$/.test(key) : key !== undefined) return reject(400, 'invalid_request');
  } catch { return reject(503, 'room_unavailable', 60); }

  let wire: string;
  const bodyDeadline = roomDeadline(config.bodyTimeoutMs, request.signal);
  try { wire = await readRoomBody(request.body, roomHttpRequestBytes(operation), bodyDeadline.signal); }
  catch (failure) {
    if (failure instanceof RoomBodyError && failure.code === 'timeout') return error(408, 'request_timeout');
    if (failure instanceof RoomBodyError && failure.code === 'limit') return error(413, 'request_too_large');
    return error(400, 'invalid_request');
  } finally { bodyDeadline.close(); }

  const workDeadline = roomDeadline(config.operationTimeoutMs, request.signal);
  const until = Date.now() + config.operationTimeoutMs;
  // D1 has no cancellation/rollback promise. The guarded clock stops later stages
  // after awaits. A batch already dispatched may commit: timeout is ALWAYS uncertain.
  const now = () => {
    if (workDeadline.signal.aborted || Date.now() >= until) throw new Error('Room operation expired');
    return Date.now();
  };
  try {
    now();
    const store = createBudgetedD1RoomStore(db, { ...config, now });
    const work = roomHttpHasKey(operation)
      ? store[operation as 'submit' | 'recover' | 'readState'](wire, key!)
      : store[operation as 'writePacket' | 'readPackets' | 'recoverPacket'](wire);
    const result = await roomWithSignal<Awaited<typeof work>>(work, workDeadline.signal);
    now();
    if (!result.ok) {
      if (result.reason === 'rate_limited') return error(429, 'room_rate_limited', Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
      if (result.reason === 'storage_error') return error(503, 'room_outcome_unknown', 1);
      if (result.reason === 'busy' || result.reason === 'not_configured') return error(503, 'room_unavailable', 1);
      // No room-existence/membership/revision/quota details, even for signed callers.
      // Unavailable says nothing about a previous uncertain attempt with this proof.
      return error(409, 'room_request_unavailable');
    }
    const body = JSON.stringify(result);
    if (requestBytes(body) > roomHttpResponseBytes(operation)) return error(503, 'room_outcome_unknown', 1);
    return new Response(body, { status: 200, headers });
  } catch { return error(503, 'room_outcome_unknown', 1); }
  finally { workDeadline.close(); }
}
