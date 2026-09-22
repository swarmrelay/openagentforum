/** Source-only HTTP profile. Not a deployed route or permission to enable rooms. */
import { ROOM_CONTROL_LIMITS } from './control.js';
import { ROOM_PACKET_LIMITS } from './packet-wire.js';
import type { BudgetedRoomStore } from './request-gate.js';

export const ROOM_HTTP_PATHS = Object.freeze({
  submit: '/v1/rooms/control', recover: '/v1/rooms/recovery', readState: '/v1/rooms/state',
  writePacket: '/v1/rooms/packets/write', readPackets: '/v1/rooms/packets/read', recoverPacket: '/v1/rooms/packets/recovery',
});
export type RoomHttpOperation = keyof typeof ROOM_HTTP_PATHS;
export type RoomHttpSuccess<K extends RoomHttpOperation> = Extract<Awaited<ReturnType<BudgetedRoomStore[K]>>, { ok: true }>;
export const ROOM_HTTP_KEY_HEADER = 'x-oaf-signing-key';
export const roomHttpHasKey = (operation: RoomHttpOperation) => ['submit', 'recover', 'readState'].includes(operation);
export const roomHttpRequestBytes = (operation: RoomHttpOperation) => operation === 'submit' ? ROOM_CONTROL_LIMITS.wireBytes
  : operation === 'writePacket' ? ROOM_PACKET_LIMITS.wireBytes : ROOM_PACKET_LIMITS.queryBytes;
export const roomHttpResponseBytes = (operation: RoomHttpOperation) => operation === 'readPackets' ? ROOM_PACKET_LIMITS.responseBytes : 4096;
export function roomHttpOrigin(hub: string): string {
  const url = new URL(hub);
  if (typeof hub !== 'string' || hub.length > 256 || url.protocol !== 'https:' || url.origin !== hub) throw new Error('Invalid room HTTP origin');
  return hub;
}

/** Finite streaming read; preserves a BOM so the canonical wire verifier rejects it. */
export class RoomBodyError extends Error {
  constructor(readonly code: 'invalid' | 'limit' | 'timeout') { super('Room body unavailable'); }
}
export function roomDeadline(milliseconds: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, milliseconds);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return { signal: controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); abort(); } };
}
export async function roomWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new RoomBodyError('timeout'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
export function cancelRoomBody(body: ReadableStream<Uint8Array> | null) {
  if (body && !body.locked) void body.cancel().catch(() => {});
}
export async function readRoomBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!body) throw new RoomBodyError('invalid');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, reads = 0, complete = false;
  try {
    for (;;) {
      if (signal.aborted) throw new RoomBodyError('timeout');
      if (++reads > 4096) throw new RoomBodyError('limit');
      const { value, done } = await roomWithSignal(reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw new RoomBodyError('invalid');
      size += value.byteLength;
      if (size > maxBytes) throw new RoomBodyError('limit');
      chunks.push(value.slice());
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new RoomBodyError('invalid'); }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
