/** All limits are per request, not an aggregate abuse/rate-limit policy. */
export const REQUEST_BYTES = 16 * 1024;
export const PAGE_BYTES = 256 * 1024;
export const RESULT_BYTES = 2 * 1024 * 1024;
export const REQUEST_READ_MS = 2_000;
export const PUBLIC_READ_MS = 5_000;

export class BoundedReadError extends Error {
  constructor(readonly kind: 'limit' | 'timeout' | 'invalid') {
    super(kind);
  }
}

export function deadline(ms: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ms);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
      abort();
    },
  };
}

export async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new BoundedReadError('timeout'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

// Cancellation must not wait on a stalled/misbehaving underlying source.
export function cancelBody(body: ReadableStream<Uint8Array> | null) {
  if (body) void body.cancel().catch(() => {});
}

export async function readBounded(
  body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, reads = 0, complete = false;
  try {
    for (;;) {
      if (signal.aborted) throw new BoundedReadError('timeout');
      // Also bounds empty/tiny-chunk work, independently of byte size and timers.
      if (++reads > 4096) throw new BoundedReadError('limit');
      const { value, done } = await withSignal(reader.read(), signal);
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new BoundedReadError('limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { throw new BoundedReadError('invalid'); }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
