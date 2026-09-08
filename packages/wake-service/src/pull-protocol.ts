import type { DeliveryResult } from './job.js';

export interface WorkRef { agentId: string; jobId: string; kind: 'verify' | 'wake' }
/** Keyset continuation, not an acknowledgment or permission to send. */
export interface PullCursor { dueAt: number; agentId: string }
export interface PollReply { ref: WorkRef | null; after: PullCursor | null }
export const INDETERMINATE: DeliveryResult = { ok: false, code: 'indeterminate', retryable: false };

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const agent = (value: unknown): value is string => typeof value === 'string' && /^agent_[a-f0-9]{16}$/.test(value);
export function isRef(value: unknown): value is WorkRef {
  return object(value) && exact(value, ['agentId', 'jobId', 'kind']) && agent(value.agentId) &&
    typeof value.jobId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.jobId) &&
    (value.kind === 'verify' || value.kind === 'wake');
}
export function isCursor(value: unknown): value is PullCursor | null {
  return value === null || (object(value) && exact(value, ['dueAt', 'agentId']) && agent(value.agentId) &&
    typeof value.dueAt === 'number' && Number.isSafeInteger(value.dueAt) && value.dueAt >= 0);
}
export function sameRef(a: WorkRef, b: WorkRef): boolean {
  return a.jobId === b.jobId && a.agentId === b.agentId && a.kind === b.kind;
}

/** Reconstruct only the small, consistent outcome vocabulary; never persist raw errors. */
export function cleanResult(value: unknown, kind: WorkRef['kind']): DeliveryResult | null {
  if (!object(value)) return null;
  const hasStatus = Object.hasOwn(value, 'status');
  if (!exact(value, ['ok', 'code', 'retryable', ...(hasStatus ? ['status'] : [])]) ||
      typeof value.ok !== 'boolean' || typeof value.retryable !== 'boolean') return null;
  const status = value.status;
  if (hasStatus && (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599)) return null;
  if (value.ok) {
    if (value.retryable || (kind === 'verify'
      ? value.code !== 'verified' || status !== 200
      : value.code !== 'delivered' || typeof status !== 'number' || status < 200 || status >= 300)) return null;
  } else {
    switch (value.code) {
      case 'dns_failed': case 'timeout': case 'network_error':
        if (!value.retryable || hasStatus) return null;
        break;
      case 'http_error':
        if (typeof status !== 'number' || status < 300 || value.retryable !== (status >= 500)) return null;
        break;
      case 'response_too_large': case 'invalid_verification':
        if (value.retryable || typeof status !== 'number' || status < 200 || status >= 300 || (value.code === 'invalid_verification' && kind !== 'verify')) return null;
        break;
      case 'unsafe_url': case 'unsafe_address': case 'tls_error': case 'indeterminate':
        if (value.retryable || hasStatus) return null;
        break;
      default: return null;
    }
  }
  // The code has been checked above, but narrow explicitly instead of retaining caller fields.
  const code = value.code;
  if (code !== 'verified' && code !== 'delivered' && code !== 'dns_failed' && code !== 'timeout' &&
      code !== 'network_error' && code !== 'http_error' && code !== 'response_too_large' &&
      code !== 'invalid_verification' && code !== 'unsafe_url' && code !== 'unsafe_address' &&
      code !== 'tls_error' && code !== 'indeterminate') return null;
  return { ok: value.ok, code, retryable: value.retryable, ...(typeof status === 'number' ? { status } : {}) };
}
