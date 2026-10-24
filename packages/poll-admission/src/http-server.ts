/** Trusted composition for native D1/SQLite stores; not a mounted public API. */
import { configuration, bytes, PollAdmissionError,
  type AdmissionInput, type PollAdmissionOptions, type ReceiptResult, type WriteRoute } from './contract.js';
import { HTTP_RESPONSE_BYTES, PollBodyError, cancelPollBody, pollDeadline, pollWithSignal,
  readPollBody, pollHttpRoute, type PollHttpErrorCode } from './http-contract.js';

export interface PollHttpOptions extends PollAdmissionOptions { bodyTimeoutMs: number }
export interface PollHttpStore<Token> {
  prepare(input: AdmissionInput, route: WriteRoute): Promise<Token>;
  commit(token: Token): ReceiptResult | Promise<ReceiptResult>;
  recover(input: AdmissionInput, channel?: string): Promise<ReceiptResult>;
}
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', vary: 'Origin' };
function error(status: number, code: PollHttpErrorCode, retryAfter?: number) {
  return new Response(JSON.stringify({ ok: false, error: code }), { status, headers: { ...headers,
    ...(status === 405 ? { allow: 'POST' } : {}), ...(retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }) } });
}

/** One handler/store per trusted composition scope; do not replace a poisoned
 * instance to evade its local bound. SQL work allowance remains database-wide. */
export function createPollHttpHandler<Token>(store: PollHttpStore<Token>, options: PollHttpOptions) {
  const { bodyTimeoutMs, ...admission } = options, config = configuration(admission);
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > config.policy.preparationMs) {
    throw new PollAdmissionError('configuration');
  }
  return async (request: Request): Promise<Response> => {
    const reject = (status: number, code: PollHttpErrorCode) => {
      cancelPollBody(request.body); return error(status, code);
    };
    const url = new URL(request.url), route = pollHttpRoute(url.pathname);
    if (!route || url.origin !== config.origin || url.search || url.hash) return reject(404, 'not_found');
    if (request.method !== 'POST') return reject(405, 'method_not_allowed');
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== config.origin) return reject(403, 'origin_not_allowed');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
      || ![null, 'identity'].includes(request.headers.get('content-encoding'))) return reject(415, 'unsupported_media_type');
    const length = request.headers.get('content-length');
    if (length !== null && (!/^(0|[1-9][0-9]{0,8})$/.test(length) || Number(length) > config.policy.wireBytes)) {
      return reject(413, 'request_too_large');
    }
    if (request.signal.aborted) return reject(408, 'request_timeout');
    const deadline = pollDeadline(config.policy.preparationMs, request.signal);
    let bodyError: PollBodyError | undefined, dispatchingCommit = false;
    const input: AdmissionInput = { signal: deadline.signal, async read() {
      // Called by the store only after the primary durable work charge succeeds.
      deadline.check();
      const bodyDeadline = pollDeadline(bodyTimeoutMs, deadline.signal);
      try {
        const wire = await readPollBody(request.body, config.policy.wireBytes, bodyDeadline.signal);
        bodyDeadline.check(); deadline.check(); return wire;
      } catch (failure) {
        bodyError = failure instanceof PollBodyError ? failure : new PollBodyError('invalid');
        throw new PollAdmissionError(bodyError.code === 'limit' ? 'input_limit' : 'invalid_input');
      } finally { bodyDeadline.close(); }
    } };
    try {
      const work = async () => {
        if (route.operation === 'recover') return store.recover(input, route.channel);
        const selected: WriteRoute = route.operation === 'close'
          ? { lane: 'completion', channel: route.channel, pollId: route.pollId } : { channel: route.channel };
        const token = await store.prepare(input, selected);
        deadline.check(); dispatchingCommit = true;
        return store.commit(token);
      };
      const result = await pollWithSignal(work(), deadline.signal);
      deadline.check();
      const body = JSON.stringify({ ok: true, ...result });
      if (bytes(body) > HTTP_RESPONSE_BYTES) return error(503, 'poll_outcome_unknown');
      return new Response(body, { headers });
    } catch (failure) {
      // Timeout/cancellation cannot stop a dispatched D1 batch. Never promise absence.
      if (dispatchingCommit && !(failure instanceof PollAdmissionError &&
        ['stale', 'storage_capacity', 'history_capacity', 'operation_conflict', 'preparation_expired'].includes(failure.code))) {
        return error(503, 'poll_outcome_unknown');
      }
      if (bodyError) return error(bodyError.code === 'timeout' ? 408 : bodyError.code === 'limit' ? 413 : 400,
        bodyError.code === 'timeout' ? 'request_timeout' : bodyError.code === 'limit' ? 'request_too_large' : 'invalid_request');
      if (failure instanceof PollBodyError) return error(408, 'request_timeout');
      if (failure instanceof PollAdmissionError) {
        if (failure.code === 'attempt_capacity') return error(429, 'poll_rate_limited', Math.max(1, Math.ceil(config.policy.windowMs / 1000)));
        if (['storage_capacity', 'history_capacity'].includes(failure.code)) return error(503, 'poll_capacity');
        if (['configuration', 'authority', 'clock', 'unavailable', 'busy'].includes(failure.code)) return error(503, 'poll_unavailable');
        if (failure.code === 'preparation_expired') return error(408, 'request_timeout');
        if (['input_limit', 'invalid_input'].includes(failure.code)) return error(400, 'invalid_request');
        return error(409, 'poll_request_refused');
      }
      return error(503, 'poll_outcome_unknown');
    } finally { deadline.close(); cancelPollBody(request.body); }
  };
}
