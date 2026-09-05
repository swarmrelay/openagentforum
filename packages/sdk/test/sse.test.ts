import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToSse as startSse } from '../src/sse.js';

// Transport fixtures are trusted here; SDK integration tests exercise real signature verification.
function subscribeToSse(...args: Parameters<typeof startSse>) {
  const [url, fetcher, receive, options, verify = async () => {}] = args;
  return startSse(url, fetcher, receive, options, verify);
}

const url = 'https://relay.test/v1/channels/general/stream';
const frame = (sequence: number) => `id: ${sequence}\nevent: envelope\ndata: {"storedSeq":${sequence},"payload":{"message":"hello"}}\n\n`;
function stream(text: string, split = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('resumable SDK SSE subscriptions', () => {
  let stop: (() => void) | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });

  it('delivers fragmented UTF-8 and multiline CRLF frames, resumes at EOF, and skips replay duplicates', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(stream('retry: 250\r\nid: 7\r\nevent: envelope\r\ndata: {"storedSeq":7,\r\ndata: "message":"héllo"}\r\n\r\nid: 8\r\ndata: {"incomplete":', 1))
      .mockResolvedValueOnce(stream(frame(7) + frame(8)));
    const receive = vi.fn();
    stop = subscribeToSse(url, fetcher, receive, { after: 6 });
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith('envelope', { storedSeq: 7, message: 'héllo' });
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('after')).toBe('6');
    await vi.advanceTimersByTimeAsync(250);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[1][1].storedSeq).toBe(8);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('after')).toBe('7');
    expect(fetcher.mock.calls[1][1].headers['Last-Event-ID']).toBe('7');
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes a starting bookmark so an empty first connection cannot lose messages during rotation', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ messages: [{ storedSeq: 12 }] }))
      .mockResolvedValueOnce(stream('event: rotate\ndata: {"reconnect":true}\n\n'))
      .mockResolvedValueOnce(stream(frame(13)));
    const receive = vi.fn();
    stop = subscribeToSse(url, fetcher, receive, { retryMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    expect(fetcher.mock.calls[0][0]).toBe('https://relay.test/v1/channels/general/messages?limit=1');
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('after')).toBe('12');
    expect(receive).toHaveBeenCalledWith('envelope', expect.objectContaining({ storedSeq: 13 }));
  });

  it('retries network and HTTP failures with backoff while preserving the saved cursor', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(stream(frame(21)));
    const onError = vi.fn();
    const receive = vi.fn();
    stop = subscribeToSse(url, fetcher, receive, { after: 20, retryMs: 250, onError });
    await vi.advanceTimersByTimeAsync(250);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(receive).toHaveBeenCalledWith('envelope', expect.objectContaining({ storedSeq: 21 }));
    expect(onError).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([input]) => new URL(input).searchParams.get('after') === '20')).toBe(true);
  });

  it('does not advance the cursor when the consumer fails to accept an envelope', async () => {
    const fetcher = vi.fn().mockImplementation(async () => stream(frame(2)));
    const onError = vi.fn();
    const receive = vi.fn().mockRejectedValueOnce(new Error('cannot persist yet')).mockResolvedValue(undefined);
    stop = subscribeToSse(url, fetcher, receive, { after: 1, retryMs: 250, onError });
    await vi.advanceTimersByTimeAsync(250);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('after')).toBe('1');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight request without reporting an error or scheduling a retry', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal;
      signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const onError = vi.fn();
    stop = subscribeToSse(url, fetcher, vi.fn(), { after: 0, onError });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal!.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects invalid cursors synchronously', () => {
    for (const after of [-1, 0.5, NaN, Infinity]) {
      expect(() => subscribeToSse(url, vi.fn(), vi.fn(), { after })).toThrow('after');
    }
  });

  it('refuses a forged high SSE id that disagrees with the envelope cursor', async () => {
    const fetcher = vi.fn().mockImplementation(async () => stream(frame(1).replace('id: 1', 'id: 999999')));
    const receive = vi.fn();
    const onError = vi.fn();
    stop = subscribeToSse(url, fetcher, receive, { after: 0, retryMs: 250, onError });
    await vi.advanceTimersByTimeAsync(250);
    expect(receive).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toContain('does not match');
    expect(fetcher.mock.calls.every(([input]) => new URL(input).searchParams.get('after') === '0')).toBe(true);
  });

  it('fills a stream gap from the record before advancing, using only record envelopes', async () => {
    const fetcher = vi.fn().mockImplementation(async (input: string) => input.includes('/stream')
      ? stream(frame(3))
      : Response.json({ messages: [1, 2, 3].map((storedSeq) => ({ storedSeq, source: 'record' })) }));
    const receive = vi.fn();
    stop = subscribeToSse(url, fetcher, receive, { after: 0, retryMs: 250 });
    await vi.advanceTimersByTimeAsync(0);
    expect(receive.mock.calls.map(([, data]) => data)).toEqual([1, 2, 3].map((storedSeq) => ({ storedSeq, source: 'record' })));
    await vi.advanceTimersByTimeAsync(250);
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('after')).toBe('3');
  });

  it('does not advance past a missing or unverified record entry', async () => {
    const fetcher = vi.fn().mockImplementation(async (input: string) => input.includes('/stream')
      ? stream(frame(9999)) : Response.json({ messages: [{ storedSeq: 1 }, { storedSeq: 2 }] }));
    const receive = vi.fn();
    const onError = vi.fn();
    const verify = vi.fn(async (data: any) => { if (data.storedSeq === 2) throw new Error('bad signature'); });
    stop = subscribeToSse(url, fetcher, receive, { after: 0, retryMs: 250, onError }, verify);
    await vi.advanceTimersByTimeAsync(250);
    expect(receive).toHaveBeenCalledOnce();
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('after')).toBe('1');
    expect(onError.mock.calls[0][0].message).toBe('bad signature');
  });
});
