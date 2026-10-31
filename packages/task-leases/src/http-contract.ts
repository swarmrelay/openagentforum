/** Unmounted draft transport for the separately opted-in lease profile. */
import { bytes, hex, object, taskId, type Action, type Options, type Proof } from './contract.js';

export const RESPONSE_BYTES = 32768;
export type Scope = Pick<Options, 'origin' | 'audience' | 'generation' | 'policyRevision'>;
export type Route = { action: 'create'; taskId: null } | { action: Exclude<Action, 'create'> | 'read'; taskId: string };
export function scope(options: Scope): Scope {
  const { origin, audience, generation, policyRevision } = options;
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || bytes(origin) > 256
    || !hex(audience, 64) || !hex(generation, 64) || typeof policyRevision !== 'string'
    || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(policyRevision)) throw new Error('Invalid task lease HTTP scope');
  return { origin, audience, generation, policyRevision };
}
export function path(route: Route): string {
  if (route.action === 'create' && route.taskId === null) return '/v1/task-leases';
  if (taskId(route.taskId)
    && ['read', 'claim', 'submit', 'release', 'reopen', 'receipt'].includes(route.action)) {
    return `/v1/task-leases/${route.taskId}${route.action === 'read' ? '' : '/' + route.action}`;
  }
  throw new Error('Invalid task lease HTTP route');
}
export function route(pathname: string): Route | null {
  if (pathname === '/v1/task-leases') return { action: 'create', taskId: null };
  const match = /^\/v1\/task-leases\/(task_[a-f0-9]{64})(?:\/(claim|submit|release|reopen|receipt))?$/.exec(pathname);
  return match ? { action: (match[2] ?? 'read') as Exclude<Action, 'create'> | 'read', taskId: match[1] } : null;
}
export const proofRoute = (proof: Proof): Route => proof.command.action === 'create'
  ? { action: 'create', taskId: null } : { action: proof.command.action, taskId: proof.taskId };
export function fields(value: unknown, names: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
}
export function sameScope(value: unknown, expected: Scope): value is Scope {
  return fields(value, ['origin', 'audience', 'generation', 'policyRevision'])
    && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}
export class BodyError extends Error {
  constructor(readonly code: 'invalid' | 'limit' | 'timeout') { super(code); }
}
export function cancelBody(body: ReadableStream<Uint8Array> | null) {
  if (body && !body.locked) void body.cancel().catch(() => {});
}
export function deadline(milliseconds: number, parent?: AbortSignal) {
  const controller = new AbortController(), started = performance.now();
  const abort = () => controller.abort(), timer = setTimeout(abort, milliseconds);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return { signal: controller.signal,
    check() { if (controller.signal.aborted || performance.now() - started >= milliseconds) { abort(); throw new BodyError('timeout'); } },
    close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); abort(); } };
}
export async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new BodyError('timeout')); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
export async function readBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!body) throw new BodyError('invalid');
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, complete = false;
  try {
    for (let reads = 0; ; reads++) {
      if (signal.aborted) throw new BodyError('timeout');
      if (reads >= 4096) throw new BodyError('limit');
      const { value, done } = await withSignal(reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw new BodyError('invalid');
      size += value.byteLength;
      if (size > maxBytes) throw new BodyError('limit');
      chunks.push(value.slice());
    }
    const buffer = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { throw new BodyError('invalid'); }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export const HTTP_ERRORS = ['invalid_request', 'method_not_allowed', 'origin_not_allowed', 'not_found',
  'unsupported_media_type', 'request_too_large', 'request_timeout', 'task_rate_limited', 'task_capacity',
  'task_request_refused', 'task_unavailable', 'task_outcome_unknown'] as const;
export type HttpCode = typeof HTTP_ERRORS[number];
