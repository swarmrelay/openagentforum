/** Draft transport contract. No public route mounts these paths. */
import { channelIdentifier, messageIdentifier } from './contract.js';

export type PollHttpRoute = { operation: 'write' | 'recover'; channel: string }
  | { operation: 'close'; channel: string; pollId: string };
export const HTTP_RESPONSE_BYTES = 4096;
export const HTTP_WIRE_BYTES = 262144;
export function pollHttpOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || origin.length > 256) throw new Error('Invalid origin');
  return origin;
}
export function pollHttpPath(route: PollHttpRoute): string {
  if (!channelIdentifier(route.channel)) throw new Error('Invalid channel');
  const base = `/v1/channels/${route.channel}`;
  if (route.operation === 'write') return `${base}/messages`;
  if (route.operation === 'recover') return `${base}/messages/recovery`;
  if (route.operation === 'close' && messageIdentifier(route.pollId)) return `${base}/polls/${route.pollId}/close`;
  throw new Error('Invalid operation');
}
export function pollHttpRoute(path: string): PollHttpRoute | null {
  const ordinary = /^\/v1\/channels\/([a-z0-9_-]{1,128})\/messages(\/recovery)?$/.exec(path);
  if (ordinary) return { operation: ordinary[2] ? 'recover' : 'write', channel: ordinary[1] };
  const close = /^\/v1\/channels\/([a-z0-9_-]{1,128})\/polls\/([a-zA-Z0-9_:-]{1,128})\/close$/.exec(path);
  if (close) return { operation: 'close', channel: close[1], pollId: close[2] };
  return null;
}
export class PollBodyError extends Error {
  constructor(readonly code: 'invalid' | 'limit' | 'timeout') { super(code); }
}
export function cancelPollBody(body: ReadableStream<Uint8Array> | null) {
  if (body && !body.locked) void body.cancel().catch(() => {});
}
export function pollDeadline(milliseconds: number, parent?: AbortSignal) {
  const controller = new AbortController(), started = performance.now();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, milliseconds);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return { signal: controller.signal,
    check() {
      if (controller.signal.aborted || performance.now() - started >= milliseconds) {
        abort(); throw new PollBodyError('timeout');
      }
    },
    close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); abort(); } };
}
export async function pollWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new PollBodyError('timeout'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
export async function readPollBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!body) throw new PollBodyError('invalid');
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, reads = 0, complete = false;
  try {
    for (;;) {
      if (signal.aborted) throw new PollBodyError('timeout');
      if (++reads > 4096) throw new PollBodyError('limit');
      const { value, done } = await pollWithSignal(reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw new PollBodyError('invalid');
      size += value.byteLength;
      if (size > maxBytes) throw new PollBodyError('limit');
      chunks.push(value.slice());
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new PollBodyError('invalid'); }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const POLL_HTTP_ERRORS = ['invalid_request', 'method_not_allowed', 'origin_not_allowed', 'not_found',
  'unsupported_media_type', 'request_too_large', 'request_timeout', 'poll_rate_limited', 'poll_capacity',
  'poll_request_refused', 'poll_unavailable', 'poll_outcome_unknown'] as const;
export type PollHttpErrorCode = typeof POLL_HTTP_ERRORS[number];
