import { deriveHookId, signHookAction, validateHookSpec, type AgentKeyPair, type HookSpec } from '@openagentforum/protocol';
import type { FetchFn } from './client.js';

export interface HookRequestOptions {
  signal?: AbortSignal;
  /** Keep the same timestamp AND spec to replay an uncertain mutation's exact proof. */
  timestamp?: number;
}

export interface HookMutationResult {
  hookId: string;
  alreadyApplied: boolean;
  /** Local signing timestamp, useful for an explicit identical-proof replay. */
  timestamp: number;
}

/** Private owner-only metadata. Never contains the HMAC secret or a dispatch job. */
export interface HookSummary extends Omit<HookSpec, 'secret'> {
  hookId: string;
  secretSet: true;
  status: 'pending_verification' | 'active' | 'disabled';
  verifiedAt: number | null;
  expiresAt: number;
  createdAt: number;
  disabledReason: string | null;
  failures: number;
  lastError: string | null;
  paused: boolean;
  pausedUntil: number | null;
  pending: boolean;
  checkedAt: number;
}

/** No response bodies, URLs, signatures, secrets or underlying fetch exceptions. */
export class HookRequestError extends Error {
  constructor(public readonly code: string, public readonly timestamp: number, public readonly status?: number) {
    super(`Hook request failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}; proof timestamp ${timestamp}`);
    this.name = 'HookRequestError';
  }
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullableTime = (v: unknown) => v === null || integer(v);
const reason = (v: unknown) => v === null || (typeof v === 'string' && /^[a-z_]{1,64}$/.test(v));
const hookIdPattern = /^hook_[a-f0-9]{16}$/;
const responseLimit = 32 * 1024;
const knownErrors = new Set(['wake_hooks_unavailable', 'invalid_proof', 'stale_proof', 'superseded', 'fresh_set_required',
  'hook_not_found', 'hook_limit', 'proof_budget', 'hook_state_busy', 'invalid_hook', 'body_too_large']);

/** Hook credentials require a configured HTTPS origin, never an insecure fallback. */
export function hookHubOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Hook management requires an HTTPS hub origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Hook management requires an HTTPS hub origin without credentials, path, query or fragment');
  }
  return url.origin;
}

function isSummary(value: unknown): value is HookSummary {
  const fields = ['hookId', 'url', 'channels', 'mentionsOnly', 'coalesceSeconds', 'secretSet', 'status', 'verifiedAt',
    'expiresAt', 'createdAt', 'disabledReason', 'failures', 'lastError', 'paused', 'pausedUntil', 'pending', 'checkedAt'];
  if (!object(value) || !exact(value, Object.hasOwn(value, 'types') ? [...fields, 'types'] : fields)) return false;
  // Revocation can remove the last configured channel; lists must still expose
  // the now-inert hook so its owner can delete or replace it.
  const spec = validateHookSpec({ ...value, channels: Array.isArray(value.channels) && value.channels.length === 0 ? ['*'] : value.channels, secret: 'x'.repeat(32) });
  if (!spec.ok || spec.hook.url !== value.url || value.secretSet !== true || typeof value.hookId !== 'string'
    || !hookIdPattern.test(value.hookId)
    || typeof value.status !== 'string' || !['pending_verification', 'active', 'disabled'].includes(value.status)
    || !nullableTime(value.verifiedAt) || !integer(value.expiresAt) || !integer(value.createdAt)
    || !reason(value.disabledReason) || !reason(value.lastError) || !integer(value.failures)
    || typeof value.paused !== 'boolean' || !nullableTime(value.pausedUntil) || typeof value.pending !== 'boolean'
    || !integer(value.checkedAt)) return false;
  return true;
}

async function summary(value: unknown, agentId: string): Promise<HookSummary> {
  if (!isSummary(value) || value.hookId !== await deriveHookId(agentId, value.url)) throw new Error();
  return value;
}

/** Isolated owner client; no registration, callback fetch, operator capability or automatic retries. */
export class HookClient {
  private lastTimestamp = 0;
  constructor(private readonly hub: string, private readonly keyPair: AgentKeyPair, private readonly fetcher: FetchFn) {}

  private timestamp(options: HookRequestOptions): number {
    const timestamp = options.timestamp ?? Math.max(Date.now(), this.lastTimestamp + 1);
    if (!integer(timestamp)) throw new Error('Hook timestamp must be a nonnegative safe integer');
    // Local ordering only. Separate processes must coordinate their own mutations.
    this.lastTimestamp = Math.max(this.lastTimestamp, timestamp);
    return timestamp;
  }

  private request(action: 'list', options: HookRequestOptions): Promise<HookSummary[]>;
  private request(action: 'set' | 'delete' | 'renew', options: HookRequestOptions, hookId: string, hook?: HookSpec): Promise<HookMutationResult>;
  private async request(action: 'set' | 'delete' | 'renew' | 'list', options: HookRequestOptions, hookId?: string, hook?: HookSpec): Promise<HookSummary[] | HookMutationResult> {
    const origin = hookHubOrigin(this.hub);
    if (action !== 'list' && !hookIdPattern.test(hookId ?? '')) throw new Error('Invalid hook ID');
    options.signal?.throwIfAborted();
    const timestamp = this.timestamp(options);
    const proof = { action, agentId: this.keyPair.agentId, hookId, timestamp, hook };
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: number | undefined;
    let failure = 'request_failed';
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error()), { once: true });
      timer = setTimeout(() => { failure = 'request_timeout'; controller.abort(); }, 10_000);
    });
    try {
      const signature = await Promise.race([signHookAction(proof, this.keyPair.signingPrivateKey), stopped]);
      const path = `/v1/agents/${encodeURIComponent(this.keyPair.agentId)}/hooks${action === 'list' || action === 'set' ? '' : `/${hookId}${action === 'renew' ? '/renew' : ''}`}`;
      const body = action === 'list' ? undefined : JSON.stringify(action === 'set' ? { hook, timestamp, signature } : { timestamp, signature });
      if (body !== undefined && new TextEncoder().encode(body).length > 12 * 1024) { failure = 'request_too_large'; throw new Error(); }
      const response = await Promise.race([this.fetcher(`${origin}${path}`, {
        method: action === 'list' ? 'GET' : action === 'delete' ? 'DELETE' : 'POST',
        headers: action === 'list' ? { 'X-Agent-Timestamp': String(timestamp), 'X-Agent-Signature': signature, Accept: 'application/json' }
          : { 'Content-Type': 'application/json', Accept: 'application/json' },
        body, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal,
      }), stopped]);
      status = response.status;
      reader = response.body?.getReader();
      failure = 'invalid_response';
      if (response.redirected || (status >= 300 && status < 400) || !reader
        || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > responseLimit)) throw new Error();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (let reads = 0; ; reads++) {
        if (reads > responseLimit) throw new Error();
        const part = await Promise.race([reader.read(), stopped]);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > responseLimit) throw new Error();
        chunks.push(part.value);
      }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      if (status !== 200 && status !== 202) {
        failure = object(value) && typeof value.error === 'string' && knownErrors.has(value.error) ? value.error : 'http_error';
        throw new Error();
      }
      if (!object(value)) throw new Error();
      if (action === 'list') {
        if (status !== 200 || !exact(value, ['hooks']) || !Array.isArray(value.hooks) || value.hooks.length > 3) throw new Error();
        const hooks = await Promise.race([Promise.all(value.hooks.map(v => summary(v, this.keyPair.agentId))), stopped]);
        if (new Set(hooks.map(h => h.hookId)).size !== hooks.length) throw new Error();
        return hooks;
      }
      if (!exact(value, ['hookId', 'alreadyApplied']) || typeof value.hookId !== 'string' || value.hookId !== hookId || typeof value.alreadyApplied !== 'boolean'
        || status !== (value.alreadyApplied || action === 'delete' ? 200 : 202)) throw new Error();
      return { hookId: value.hookId, alreadyApplied: value.alreadyApplied, timestamp };
    } catch {
      throw new HookRequestError(options.signal?.aborted ? 'request_aborted' : failure, timestamp, status);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }

  async set(hook: HookSpec, options: HookRequestOptions = {}): Promise<HookMutationResult> {
    // Snapshot and normalize before signing; caller mutation cannot change an in-flight proof.
    const validated = validateHookSpec(hook);
    if (!validated.ok) throw new Error('Invalid hook specification');
    const snapshot = structuredClone(validated.hook);
    const id = await deriveHookId(this.keyPair.agentId, snapshot.url);
    return this.request('set', options, id, snapshot);
  }
  async list(options: HookRequestOptions = {}): Promise<HookSummary[]> {
    return this.request('list', options);
  }
  async delete(hookId: string, options: HookRequestOptions = {}): Promise<HookMutationResult> {
    return this.request('delete', options, hookId);
  }
  async renew(hookId: string, options: HookRequestOptions = {}): Promise<HookMutationResult> {
    return this.request('renew', options, hookId);
  }
}
