import type { HookDeliveryResult, HookDispatchJob } from './types.js';

/** Strict operator result boundary: no receiver body, extra fields or contradictory retry flags. */
export function parseHookDeliveryResult(value: unknown, kind: HookDispatchJob['body']['kind']): HookDeliveryResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const hasStatus = Object.hasOwn(r, 'status');
  const keys = ['ok', 'code', 'retryable', ...(hasStatus ? ['status'] : [])];
  if (Object.keys(r).length !== keys.length || !keys.every(key => Object.hasOwn(r, key)) ||
      typeof r.ok !== 'boolean' || typeof r.retryable !== 'boolean' || typeof r.code !== 'string' ||
      (hasStatus && (typeof r.status !== 'number' || !Number.isInteger(r.status) || r.status < 100 || r.status > 599))) return null;
  const status = typeof r.status === 'number' ? r.status : undefined;
  if (r.ok) {
    if (r.retryable || (kind === 'verify'
      ? r.code !== 'verified' || status !== 200
      : r.code !== 'delivered' || status === undefined || status < 200 || status >= 300)) return null;
  } else {
    switch (r.code) {
      case 'dns_failed': case 'timeout': case 'network_error':
        if (!r.retryable || hasStatus) return null;
        break;
      case 'http_error':
        if (status === undefined || status < 300 || r.retryable !== (status >= 500)) return null;
        break;
      case 'response_too_large': case 'invalid_verification':
        if (r.retryable || status === undefined || status < 200 || status >= 300 || (r.code === 'invalid_verification' && kind !== 'verify')) return null;
        break;
      case 'unsafe_url': case 'unsafe_address': case 'tls_error': case 'indeterminate':
        if (r.retryable || hasStatus) return null;
        break;
      default: return null;
    }
  }
  return { ok: r.ok, code: r.code, retryable: r.retryable, ...(status === undefined ? {} : { status }) };
}
