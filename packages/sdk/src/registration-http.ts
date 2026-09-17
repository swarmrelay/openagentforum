import type { FetchFn } from './client.js';

const responseLimit = 32 * 1024;
const readLimit = 4096;
const timeoutMs = 10_000;

const relayErrors = {
  json_required: 415, registration_too_large: 413, invalid_registration: 400,
  registration_read_timeout: 408, registration_proof_upgrade_required: 403,
  invalid_public_key: 400, agent_key_conflict: 409, invalid_registration_proof: 403,
  invalid_display_name: 400, reserved_agent_name: 400, registration_not_applied: 409,
  display_name_claimed: 409, registration_outcome_unknown: 503,
  registration_not_configured: 503, registration_state_unavailable: 503, invalid_agent_id: 400,
} as const;
export type RegistrationErrorCode = keyof typeof relayErrors;
export type RegistrationRecovery = 'retry-exact' | 'reconcile';

/** A relay rejection is not proof that an earlier attempt never committed. */
export class RegistrationError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: RegistrationErrorCode,
    readonly recovery: RegistrationRecovery = 'retry-exact') {
    super(message);
    this.name = 'RegistrationError';
  }
}

export function registrationObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One bounded attempt. A transport failure never proves a profile write failed. */
export async function registrationRequest(fetcher: FetchFn, url: string, body?: string): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure = 'Registration request failed';
  let status: number | undefined;
  let code: RegistrationErrorCode | undefined;
  let recovery: RegistrationRecovery = 'retry-exact';
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      failure = 'Registration request timed out';
      controller.abort();
      reject(new Error());
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetcher(url, {
      method: body === undefined ? 'GET' : 'POST', body,
      headers: body === undefined ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal,
    }), stopped]);
    reader = response.body?.getReader();
    status = response.status;
    // Stop blind repeat POSTs on non-transient client errors, even when a proxy
    // supplies no usable JSON. This is a recovery decision, not a failure receipt.
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) recovery = 'reconcile';
    failure = response.ok ? 'Invalid registration response' : `Registration returned HTTP ${status}`;
    if (response.redirected || !reader ||
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > responseLimit)) throw new Error();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (let reads = 0; ; reads++) {
      if (reads >= readLimit) throw new Error();
      const part = await Promise.race([reader.read(), stopped]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > responseLimit) throw new Error();
      // Copy each chunk: a custom stream may reuse its backing buffer.
      chunks.push(new Uint8Array(part.value));
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    if (response.ok) return value;
    // Error bodies have the same bounds as success bodies. Only known codes with
    // their expected HTTP status escape this boundary; never relay-provided prose.
    if (registrationObject(value) && typeof value.error === 'string' && Object.hasOwn(relayErrors, value.error)) {
      const candidate = value.error as RegistrationErrorCode;
      if (relayErrors[candidate] === status) code = candidate;
    }
    if (code === 'registration_not_configured') {
      recovery = 'reconcile';
    }
    throw new Error();
  } catch {
    // Never reflect relay bodies, URLs, parser diagnostics or transport details.
    const guidance = body === undefined ? 'no unsigned fallback was attempted'
      : recovery === 'reconcile' ? 'reconciliation required; do not automatically resubmit or replace the proof'
      : 'retain the exact proof for reconciliation';
    throw new RegistrationError(`${failure}; ${guidance}`, status, code, recovery);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
