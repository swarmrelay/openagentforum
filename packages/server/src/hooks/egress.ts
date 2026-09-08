import { HookError, type HookDeliveryResult, type HookDispatchJob } from './types.js';
import { parseHookDeliveryResult } from './result.js';

const MAX_JOB_BYTES = 8192;
const MAX_RESULT_BYTES = 2048;
export const MAX_EGRESS_TIMEOUT_MS = 10_000;

export type HookEgressOutcome =
  | { kind: 'result'; duplicate: boolean; result: HookDeliveryResult }
  | { kind: 'uncertain'; code: 'service_unavailable' | 'service_timeout' | 'service_rejected' | 'invalid_service_response' | 'aborted'; replayable: boolean };
export interface HookEgressClient {
  /** Only the fixed, operator-configured service endpoint; never job.url. */
  submit(job: HookDispatchJob, signal?: AbortSignal): Promise<HookEgressOutcome>;
}
export interface HookEgressOptions {
  endpoint: string;
  /** Privileged service credential, NOT the agent's hook secret. */
  token: string;
  timeoutMs?: number;
  /** Trusted infrastructure/test seam, never configurable by agent requests. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Reject unknown fields and contradictory results instead of trusting a 200 or retryable flag. */
function outcome(value: unknown, kind: HookDispatchJob['body']['kind']): HookEgressOutcome | null {
  if (!object(value) || !exact(value, ['duplicate', 'result']) || typeof value.duplicate !== 'boolean' || !object(value.result)) return null;
  const result = parseHookDeliveryResult(value.result, kind);
  return result ? { kind: 'result', duplicate: value.duplicate, result } : null;
}

async function readResult(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  // Do not await cancellation: a broken stream's cancel promise can itself hang.
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let reads = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      if (++reads > MAX_RESULT_BYTES + 1) throw new Error();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESULT_BYTES) throw new Error();
      chunks.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** HTTPS authenticates the configured service. Only that service may dial callback URLs. */
export function createHookEgressClient(options: HookEgressOptions): HookEgressClient {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { throw new HookError('invalid_egress_config', 503); }
  const timeoutMs = options.timeoutMs ?? 8000;
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port ||
      endpoint.pathname !== '/internal/deliver' || endpoint.search || endpoint.hash ||
      endpoint.href !== options.endpoint || !/^[a-f0-9]{64}$/.test(options.token) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EGRESS_TIMEOUT_MS) throw new HookError('invalid_egress_config', 503);
  const url = endpoint.href;
  const token = options.token;
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async submit(job, signal) {
      const uncertain = (code: Extract<HookEgressOutcome, { kind: 'uncertain' }>['code'], replayable = false): HookEgressOutcome => ({ kind: 'uncertain', code, replayable });
      if (signal?.aborted) return uncertain('aborted');
      let body: string;
      try {
        body = JSON.stringify(job);
        if (new TextEncoder().encode(body).byteLength > MAX_JOB_BYTES) return uncertain('service_rejected');
      } catch { return uncertain('service_rejected'); }
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let onAbort!: () => void;
      const aborted = new Promise<HookEgressOutcome>(resolve => {
        onAbort = () => resolve(uncertain(timedOut ? 'service_timeout' : 'aborted', timedOut));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const request = async (): Promise<HookEgressOutcome> => {
        let response: Response;
        try {
          response = await send(url, {
            method: 'POST', redirect: 'manual', cache: 'no-store', signal: controller.signal,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' },
            body,
          });
        } catch { return uncertain(controller.signal.aborted ? timedOut ? 'service_timeout' : 'aborted' : 'service_unavailable', !signal?.aborted); }
        try {
          if (controller.signal.aborted) return uncertain(timedOut ? 'service_timeout' : 'aborted', timedOut);
          if (response.redirected || (response.url && response.url !== url)) return uncertain('invalid_service_response');
          if (response.status !== 200) return uncertain('service_rejected', [502, 503, 504].includes(response.status));
          const length = response.headers.get('content-length');
          if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
              response.headers.has('content-encoding') ||
              (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESULT_BYTES))) return uncertain('invalid_service_response');
          return outcome(await readResult(response, controller.signal), job.body.kind) ?? uncertain('invalid_service_response');
        } catch { return uncertain(controller.signal.aborted ? timedOut ? 'service_timeout' : 'aborted' : 'invalid_service_response', timedOut); }
        finally { if (response.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
      };
      try { return await Promise.race([request(), aborted]); }
      finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
