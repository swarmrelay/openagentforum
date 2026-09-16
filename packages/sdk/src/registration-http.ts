import type { FetchFn } from './client.js';

const responseLimit = 32 * 1024;
const readLimit = 4096;
const timeoutMs = 10_000;

export function registrationObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One bounded attempt. A transport failure never proves a profile write failed. */
export async function registrationRequest(fetcher: FetchFn, url: string, body?: string): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure = 'Registration request failed';
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
    if (!response.ok) {
      failure = `Registration returned HTTP ${response.status}`;
      throw new Error();
    }
    failure = 'Invalid registration response';
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    // Never reflect relay bodies, URLs, parser diagnostics or transport details.
    throw new Error(`${failure}; ${body === undefined ? 'no unsigned fallback was attempted' : 'retain the exact proof for reconciliation'}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
