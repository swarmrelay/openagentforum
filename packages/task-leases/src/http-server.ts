/** Trusted composition only. No production route or schema provisioning. */
import { LIMITS, TaskLeaseError, bounded, bytes, configuration, object, type Input, type Lane, type Options,
  type Result, type view } from './contract.js';
import { BodyError, RESPONSE_BYTES, cancelBody, deadline, readBody, route, scope, withSignal, type HttpCode } from './http-contract.js';

export interface TaskLeaseHttpOptions extends Options { bodyTimeoutMs: number }
export interface TaskLeaseHttpStore<Token> {
  prepare(input: Input, lane: Exclude<Lane, 'recovery'>): Promise<Token>;
  commit(token: Token): Promise<Result>;
  recover(input: Input): Promise<Result>;
  readTask(id: string): Promise<ReturnType<typeof view> | null>;
}
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', vary: 'Origin' };
function error(status: number, code: HttpCode, allow = 'POST', retryAfter?: number) {
  return new Response(JSON.stringify({ ok: false, error: code }), { status, headers: { ...headers,
    ...(status === 405 ? { allow } : {}), ...(retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }) } });
}

/** Preserve the caller-owned store's bounded operation scope and poisoned state.
 * Do not replace it to evade failure or concurrency checks. */
export function createTaskLeaseHttpHandler<Token>(store: TaskLeaseHttpStore<Token>, options: TaskLeaseHttpOptions) {
  const { bodyTimeoutMs, ...admission } = options, config = configuration(admission), pinned = scope(config);
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > config.policy.preparationMs) {
    throw new TaskLeaseError('configuration');
  }
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), selected = route(url.pathname);
    const allow = selected?.action === 'read' ? 'GET, HEAD' : 'POST';
    const reject = (status: number, code: HttpCode) => { cancelBody(request.body); return error(status, code, allow); };
    if (!selected || url.origin !== config.origin || url.search || url.hash) return reject(404, 'not_found');
    if (!(selected.action === 'read' ? ['GET', 'HEAD'].includes(request.method) : request.method === 'POST')) {
      return reject(405, 'method_not_allowed');
    }
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== config.origin) return reject(403, 'origin_not_allowed');
    if (selected.action !== 'read') {
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
        || ![null, 'identity'].includes(request.headers.get('content-encoding'))) return reject(415, 'unsupported_media_type');
      const length = request.headers.get('content-length');
      if (length !== null && (!/^(0|[1-9][0-9]{0,8})$/.test(length) || Number(length) > LIMITS.wireBytes)) {
        return reject(413, 'request_too_large');
      }
    } else if (request.body) return reject(400, 'invalid_request');
    if (request.signal.aborted) return reject(408, 'request_timeout');
    const overall = deadline(config.policy.preparationMs, request.signal);
    let bodyError: BodyError | undefined, dispatchingCommit = false;
    const input: Input = { signal: overall.signal, async read() {
      // The store calls this once, after its primary durable charge succeeds.
      overall.check(); const bodyTime = deadline(bodyTimeoutMs, overall.signal);
      try {
        const wire = await readBody(request.body, LIMITS.wireBytes, bodyTime.signal);
        bodyTime.check(); overall.check();
        // This only rejects route mismatches. The store still verifies the exact
        // original canonical wire, signature, current actor and state itself.
        let envelope: unknown;
        try { envelope = JSON.parse(wire); bounded(envelope); } catch { throw new BodyError('invalid'); }
        if (!object(envelope) || !object(envelope.command) || envelope.command.action !== selected.action
          || envelope.command.taskId !== selected.taskId) throw new BodyError('invalid');
        return wire;
      } catch (failure) {
        bodyError = failure instanceof BodyError ? failure : new BodyError('invalid'); throw failure;
      } finally { bodyTime.close(); }
    } };
    try {
      const work = async () => {
        if (selected.action === 'read') return { task: await store.readTask(selected.taskId) };
        if (selected.action === 'receipt') return store.recover(input);
        const token = await store.prepare(input, ['submit', 'release'].includes(selected.action) ? 'completion' : 'ordinary');
        overall.check(); dispatchingCommit = true; return store.commit(token);
      };
      const result = await withSignal(work(), overall.signal); overall.check();
      const body = JSON.stringify({ ok: true, scope: pinned, ...result });
      if (bytes(body) > RESPONSE_BYTES) return error(503, dispatchingCommit ? 'task_outcome_unknown' : 'task_unavailable');
      return new Response(request.method === 'HEAD' ? null : body, { headers });
    } catch (failure) {
      // A dispatched batch can commit after HTTP cancellation. Unknown outcomes
      // never establish absence or permission to sign a replacement operation.
      if (dispatchingCommit && !(failure instanceof TaskLeaseError && ['stale', 'revision', 'capacity', 'sealed',
        'claimed', 'reconciliation_required', 'generation', 'creator', 'holder', 'lease_expired',
        'operation_conflict', 'proof_expired', 'scope'].includes(failure.code))) return error(503, 'task_outcome_unknown');
      if (bodyError) return error(bodyError.code === 'timeout' ? 408 : bodyError.code === 'limit' ? 413 : 400,
        bodyError.code === 'timeout' ? 'request_timeout' : bodyError.code === 'limit' ? 'request_too_large' : 'invalid_request');
      if (failure instanceof BodyError) return error(408, 'request_timeout');
      if (failure instanceof TaskLeaseError) {
        if (failure.code === 'attempt_capacity') return error(429, 'task_rate_limited', allow, Math.max(1, Math.ceil(config.policy.windowMs / 1000)));
        if (failure.code === 'capacity') return error(503, 'task_capacity');
        if (['configuration', 'authority', 'clock', 'unavailable', 'busy'].includes(failure.code)) return error(503, 'task_unavailable');
        if (failure.code === 'preparation_expired') return error(408, 'request_timeout');
        if (failure.code === 'invalid') return error(400, 'invalid_request');
        return error(409, 'task_request_refused');
      }
      return error(503, dispatchingCommit ? 'task_outcome_unknown' : 'task_unavailable');
    } finally { overall.close(); cancelBody(request.body); }
  };
}
