import { deriveHookId, validateHookUrl } from '@openagentforum/protocol';
import type { HookManager } from './manager.js';
import { MAX_DUE_BATCH, type HookDueCursor, type HookDueStore } from './due.js';
import { HookError, STATE_LIMITS, type HookDispatchJob } from './types.js';
import { parseHookDeliveryResult } from './result.js';
import { controlWindow, type HookControlAdmission } from './control-admission.js';

export { d1HookControlAdmission, HOOK_CONTROL_SCHEMA, MAX_CONTROL_REQUESTS_PER_SECOND } from './control-admission.js';
export type { HookControlAdmission } from './control-admission.js';

export interface HookControlRef { agentId: string; jobId: string; kind: 'verify' | 'wake' }
export interface HookControlOptions {
  /** Exact operator HTTPS URL. Never derive this from an incoming Host header. */
  endpoint: string;
  hub: string;
  /** Dedicated random 32-byte lowercase-hex bearer; never an agent or account credential. */
  token: string;
  manager: Pick<HookManager, 'claim' | 'authorizeDispatch' | 'complete'>;
  store: HookDueStore;
  /** Required durable, shared primary admission gate; no in-memory fallback. */
  admission: HookControlAdmission;
  /** Trusted bounded origin fan-out, only after operator auth/admission and a valid poll. Await all SQL; stop admitting work when inTime() is false. */
  preparePoll?: (inTime: () => boolean) => Promise<void>;
  scanLimit?: number;
  /** Stops admitting more work and suppresses late jobs; does not cancel SQL already in progress. */
  admissionMs?: number;
  now?: () => number;
}

const MAX_BODY = 2048;
const MAX_HEADERS = 8192;
const MAX_JOB = 8192;
const encoder = new TextEncoder();
const clientErrors: Readonly<Record<string, number>> = {
  json_required: 400, invalid_body_length: 413, body_required: 400,
  body_timeout: 408, request_aborted: 408, invalid_json: 400, body_too_large: 413,
  too_many_chunks: 413, control_timeout: 408, invalid_control_request: 400,
  invalid_control_result: 400, invalid_claim_kind: 409,
};
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function cursor(value: unknown): value is HookDueCursor {
  return object(value) && exact(value, ['dueAt', 'agentId']) && typeof value.dueAt === 'number' && Number.isSafeInteger(value.dueAt) && value.dueAt >= 0 &&
    typeof value.agentId === 'string' && /^agent_[a-f0-9]{16}$/.test(value.agentId);
}
function reference(value: unknown): value is HookControlRef {
  return object(value) && exact(value, ['agentId', 'jobId', 'kind']) &&
    typeof value.agentId === 'string' && /^agent_[a-f0-9]{16}$/.test(value.agentId) &&
    typeof value.jobId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.jobId) &&
    (value.kind === 'verify' || value.kind === 'wake');
}
function follows(next: HookDueCursor, previous: HookDueCursor | null) {
  return !previous || next.dueAt > previous.dueAt || (next.dueAt === previous.dueAt && next.agentId > previous.agentId);
}
function json(value: object, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '1' } : {}) } });
}

async function body(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || request.headers.has('content-encoding')) throw new HookError('json_required', 400);
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new HookError('invalid_body_length', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new HookError('body_required', 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HookError('body_timeout', 408)), 1000);
    abort = () => reject(new HookError('request_aborted', 408));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
  const buffer = new Uint8Array(MAX_BODY);
  let bytes = 0;
  try {
    for (let reads = 0; reads <= MAX_BODY; reads++) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) {
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))); }
        catch { throw new HookError('invalid_json', 400); }
      }
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY) throw new HookError('body_too_large', 413);
      buffer.set(part.value, bytes - part.value.byteLength);
    }
    throw new HookError('too_many_chunks', 413);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    // Never wait for a peer-controlled cancel promise. No SQL is raced or detached.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Opt-in privileged adapter. Not registered in any public agent route or production Worker. */
export async function createHookControlHandler(options: HookControlOptions): Promise<(request: Request) => Promise<Response>> {
  let endpoint: URL;
  let hub: URL;
  try { endpoint = new URL(options.endpoint); hub = new URL(options.hub); }
  catch { throw new HookError('invalid_control_config', 503); }
  const scanLimit = options.scanLimit ?? 25;
  const admissionMs = options.admissionMs ?? 2000;
  if (!validateHookUrl(options.endpoint).ok || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== '/internal/wake-control' ||
      endpoint.search || endpoint.hash || endpoint.href !== options.endpoint || hub.protocol !== 'https:' || hub.origin !== options.hub ||
      !/^[a-f0-9]{64}$/.test(options.token) || !Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > MAX_DUE_BATCH ||
      !Number.isSafeInteger(admissionMs) || admissionMs < 1 || admissionMs > 2000 || typeof options.admission?.admit !== 'function') throw new HookError('invalid_control_config', 503);
  const { manager, store, admission } = options;
  const now = options.now ?? Date.now;
  const expectedHub = options.hub;
  const expectedEndpoint = endpoint.href;
  // Native MAC verification avoids a JS secret-string comparison and also works
  // in Node, where Workers' nonstandard timingSafeEqual extension is absent.
  // Only immutable key/MAC material is shared across requests, never admission state.
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`Bearer ${options.token}`));

  return async request => {
    const started = performance.now();
    const inTime = () => !request.signal.aborted && performance.now() - started < admissionMs;
    const requireTime = () => { if (!inTime()) throw new HookError('control_timeout', 408); };
    try {
      if (request.url !== expectedEndpoint) return json({ error: 'not_found' }, 404);
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      let headerBytes = 0;
      request.headers.forEach((value, name) => {
        if (headerBytes > MAX_HEADERS) return;
        headerBytes += name.length + value.length > MAX_HEADERS ? MAX_HEADERS + 1 : encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
      });
      if (headerBytes > MAX_HEADERS) return json({ error: 'headers_too_large' }, 431);
      const authorization = request.headers.get('authorization') ?? '';
      if (!/^Bearer [a-f0-9]{64}$/.test(authorization) || !await crypto.subtle.verify('HMAC', key, mac, encoder.encode(authorization))) return json({ error: 'unauthorized' }, 401);
      requireTime();
      const time = now();
      controlWindow(time);
      if (!await admission.admit(time)) return json({ error: 'control_rate_limited' }, 429);
      requireTime();
      const input = await body(request);
      requireTime();
      if (!object(input)) throw new HookError('invalid_control_request', 400);
      if (input.op === 'poll' && exact(input, ['op', 'after']) && (input.after === null || cursor(input.after))) {
        if (options.preparePoll) await options.preparePoll(inTime);
        requireTime();
        const after = input.after;
        const page = await store.scanDue(time, scanLimit, after);
        requireTime();
        if (!Array.isArray(page) || page.length > scanLimit) throw new Error();
        let previous = after;
        // Validate the entire advisory page before attempting any state mutation.
        for (const row of page) {
          if (!cursor(row) || row.dueAt > time || !follows(row, previous)) throw new Error();
          previous = row;
        }
        let visited = after;
        for (let i = 0; i < page.length; i++) {
          if (!inTime()) return json({ ref: null, after: visited });
          const row = page[i];
          visited = { dueAt: row.dueAt, agentId: row.agentId };
          const next = i === page.length - 1 && page.length < scanLimit ? null : visited;
          let job: HookDispatchJob | null;
          try { job = await manager.claim(row.agentId); }
          catch {
            // A failed response may hide a committed claim. Stop this poll, but
            // advance past the owner so one corrupt record cannot starve a sweep.
            return json({ ref: null, after: next });
          }
          if (job) {
            const ref = { agentId: row.agentId, jobId: job.jobId, kind: job.body.kind };
            if (!reference(ref) || job.body.agentId !== row.agentId || job.body.hub !== expectedHub) throw new Error();
            // A late claim remains durable but cannot escape as dispatch authority.
            return json({ ref: inTime() ? ref : null, after: next });
          }
        }
        return json({ ref: null, after: page.length === scanLimit ? visited : null });
      }
      if (input.op === 'authorize' && exact(input, ['op', 'ref']) && reference(input.ref)) {
        const ref = input.ref;
        const job = await manager.authorizeDispatch(ref.agentId, ref.jobId);
        if (!job || !inTime()) return json({ job: null });
        const url = validateHookUrl(job.url);
        if (job.jobId !== ref.jobId || job.body.agentId !== ref.agentId || job.body.kind !== ref.kind || job.body.hub !== expectedHub ||
            !url.ok || await deriveHookId(ref.agentId, url.url.toString()) !== job.body.hookId) return json({ job: null });
        const current = now();
        controlWindow(current);
        if (!Number.isSafeInteger(job.body.sentAt) || current < job.body.sentAt || current - job.body.sentAt >= STATE_LIMITS.leaseMs || !inTime()) return json({ job: null });
        if (encoder.encode(JSON.stringify(job)).byteLength > MAX_JOB) throw new Error();
        return json({ job });
      }
      if (input.op === 'complete' && exact(input, ['op', 'ref', 'result']) && reference(input.ref)) {
        const ref = input.ref;
        const result = parseHookDeliveryResult(input.result, ref.kind);
        if (!result) throw new HookError('invalid_control_result', 400);
        // Await the CAS (including stale-claim cleanup). A thrown/uncertain commit
        // is never acknowledged; a replay can safely acknowledge applied:false.
        await manager.complete(ref.agentId, ref.jobId, result, ref.kind);
        return json({ ack: ref });
      }
      throw new HookError('invalid_control_request', 400);
    } catch (error) {
      // Raw DB, crypto and callback details must not cross this boundary.
      if (error instanceof HookError && Object.hasOwn(clientErrors, error.code) && clientErrors[error.code] === error.status) return json({ error: error.code }, error.status);
      return json({ error: 'control_unavailable' }, 503);
    } finally {
      // Also release unread denied requests, without consuming attacker data or
      // waiting on its cancellation implementation.
      if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
    }
  };
}
