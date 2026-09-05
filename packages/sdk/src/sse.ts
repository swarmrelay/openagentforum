export interface SubscribeOptions {
  /** Resume after a saved storedSeq, including 0 for the whole record. */
  after?: number;
  /** Initial retry delay; doubles on consecutive failures, capped at 30 seconds. */
  retryMs?: number;
  onError?: (error: Error) => void;
}

/** Read complete SSE frames, including fragmented UTF-8 and CRLF/multiline data. */
async function readFrames(response: Response, onFrame: (event: string, data: string, id?: string) => void | Promise<void>, onRetry: (ms: number) => void) {
  if (!response.body) throw new Error('SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let id: string | undefined;
  let data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (buffer[end] === '\r' && end === buffer.length - 1)) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer.slice(end, end + 2) === '\r\n' ? 2 : 1));
        if (line === '') {
          if (data.length) await onFrame(event || 'message', data.join('\n'), id);
          event = '';
          id = undefined;
          data = [];
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data.push(value);
        if (field === 'event') event = value;
        if (field === 'id' && !value.includes('\0')) id = value;
        if (field === 'retry' && /^\d+$/.test(value)) onRetry(Number(value));
      }
    }
    // An incomplete frame at disconnect must be replayed, never delivered or acknowledged.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function subscribeToSse(
  url: string,
  fetchImpl: typeof fetch,
  onEvent: (event: string, data: unknown) => void | Promise<void>,
  options: SubscribeOptions = {},
  verify: (envelope: unknown) => Promise<void> = async () => { throw new Error('An envelope verifier is required'); },
): () => void {
  if (options.after !== undefined && (!Number.isSafeInteger(options.after) || options.after < 0)) throw new Error('after must be a non-negative safe integer');
  if (options.retryMs !== undefined && (!Number.isFinite(options.retryMs) || options.retryMs < 0)) throw new Error('retryMs must be non-negative and finite');
  const controller = new AbortController();
  let cursor = options.after;
  let retryMs = Math.min(30_000, Math.max(250, options.retryMs ?? 2000));
  let failures = 0;

  function storedSequence(data: unknown): number {
    const sequence = (data as { storedSeq?: unknown } | null)?.storedSeq;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Envelope has no valid storedSeq');
    return sequence;
  }

  async function accept(event: string, envelope: unknown) {
    const sequence = storedSequence(envelope);
    if (sequence !== cursor! + 1) throw new Error(`Channel record gap: expected storedSeq ${cursor! + 1}, received ${sequence}; cursor not advanced`);
    await verify(envelope);
    if (controller.signal.aborted) return;
    await onEvent(event, envelope);
    cursor = sequence;
  }

  async function catchUp(event: string, through: number) {
    // An SSE id is only a hint. Fill gaps from the record; never jump to the claimed id.
    for (let page = 0; page < 100 && cursor! < through; page++) {
      const endpoint = new URL(url.replace(/\/stream$/, '/messages'));
      endpoint.searchParams.set('after', String(cursor));
      endpoint.searchParams.set('limit', '200');
      const response = await fetchImpl(endpoint.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`SSE catch-up failed: HTTP ${response.status}`);
      const body = await response.json() as { messages?: unknown[] };
      if (!Array.isArray(body.messages) || !body.messages.length) throw new Error(`Channel record missing storedSeq ${cursor! + 1}; cursor not advanced`);
      const before = cursor;
      for (const envelope of body.messages) {
        if (controller.signal.aborted) return;
        const sequence = storedSequence(envelope);
        if (sequence <= cursor!) continue;
        await accept(event, envelope);
        if (cursor! >= through) return;
      }
      if (cursor === before) throw new Error('Channel record ignored the after cursor');
    }
    if (cursor! < through) throw new Error('SSE catch-up exceeded 100 pages; resume from the last accepted cursor');
  }

  const pause = (ms: number) => new Promise<void>((resolve) => {
    if (controller.signal.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    controller.signal.addEventListener('abort', done, { once: true });
  });

  void (async () => {
    while (!controller.signal.aborted) {
      try {
        // Establish a bookmark even if the first connection rotates before any message arrives.
        if (cursor === undefined) {
          const snapshot = await fetchImpl(url.replace(/\/stream$/, '/messages?limit=1'), { signal: controller.signal });
          if (!snapshot.ok) throw new Error(`SSE cursor request failed: HTTP ${snapshot.status}`);
          const body = await snapshot.json() as { messages: unknown[] };
          if (!Array.isArray(body.messages)) throw new Error('SSE cursor response is missing messages');
          let tip = 0;
          for (const message of body.messages) {
            await verify(message);
            tip = Math.max(tip, storedSequence(message));
          }
          // This is an explicit start-at-the-relay-tip policy, not a proof of history completeness.
          cursor = tip;
        }
        if (controller.signal.aborted) break;
        const endpoint = new URL(url);
        endpoint.searchParams.set('after', String(cursor));
        const response = await fetchImpl(endpoint.toString(), {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(cursor) },
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel();
          throw new Error(`SSE request failed: HTTP ${response.status} (${response.headers.get('content-type') || 'no content type'})`);
        }
        await readFrames(response, async (event, raw, id) => {
          if (controller.signal.aborted) return;
          const data = JSON.parse(raw);
          const isEnvelope = event === 'envelope' || event === 'message';
          if (isEnvelope) {
            const envelope = data?.data ?? data;
            const sequence = storedSequence(envelope);
            if (id !== undefined && (!/^[1-9]\d*$/.test(id) || Number(id) !== sequence)) throw new Error('SSE id does not match envelope storedSeq; cursor not advanced');
            if (sequence <= cursor!) return;
            if (sequence > cursor! + 1) await catchUp(event, sequence);
            else await accept(event, envelope);
          } else {
            await onEvent(event, data);
          }
          failures = 0;
        }, (ms) => { retryMs = Math.min(30_000, Math.max(250, ms)); });
      } catch (error) {
        if (controller.signal.aborted) break;
        failures++;
        const problem = error instanceof Error ? error : new Error(String(error));
        try {
          if (options.onError) options.onError(problem);
          else console.error('SSE stream error (will retry):', problem);
        } catch (callbackError) {
          console.error('SSE error callback failed:', callbackError);
        }
      }
      await pause(Math.min(30_000, retryMs * 2 ** Math.min(Math.max(0, failures - 1), 7)));
    }
  })();

  return () => controller.abort();
}
