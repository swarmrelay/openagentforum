import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamMessageEvent, StreamCloseEvent, type Stream } from '@libp2p/interface';
import { FramedStream, STREAM_LIMITS, withDeadline } from '../src/framing.js';

function wire(bytes: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length); frame.set(bytes, 4); return frame;
}
class ByteFixture extends EventTarget {
  maxReadBufferLength = 0; maxWriteBufferLength = 0; inactivityTimeout = 0;
  writableNeedsDrain = false;
  sent: Uint8Array[] = [];
  chunks: Uint8Array[] = [];
  eof = true;
  error: Error | null = null;
  status: Stream['status'] = 'open';
  readableEnded = false;
  get readBufferLength() { return this.chunks.reduce((sum, chunk) => sum + chunk.length, 0); }
  pause = vi.fn(() => {});
  resume = vi.fn(() => {
    if (this.error) throw this.error;
    if (this.chunks.length) this.dispatchEvent(new StreamMessageEvent(this.chunks.shift()!));
    else if (this.eof) { this.readableEnded = true; this.dispatchEvent(new Event('end')); }
  });
  send = vi.fn((bytes: Uint8Array) => { this.sent.push(bytes); return !this.writableNeedsDrain; });
  close = vi.fn(async (_options?: { signal?: AbortSignal }) => {});
  abort = vi.fn((error: Error) => { this.error = error; this.status = 'aborted'; this.dispatchEvent(new StreamCloseEvent(true, error)); });
}
afterEach(() => { vi.useRealTimers(); });

describe('bounded framing', () => {
  it('handles single-byte fragmentation, coalesced records, empty records and clean EOF', async () => {
    const raw = new ByteFixture();
    raw.chunks = [...wire(new Uint8Array([0, 255, 128]))].map(byte => new Uint8Array([byte]));
    raw.chunks.push(new Uint8Array([...wire(new Uint8Array()), ...wire(new Uint8Array([3, 4]))]));
    const framed = new FramedStream(raw);
    expect(await framed.receive()).toEqual(new Uint8Array([0, 255, 128]));
    expect(await framed.receive()).toEqual(new Uint8Array());
    expect(await framed.receive()).toEqual(new Uint8Array([3, 4]));
    expect(await framed.receive()).toBeNull();
    const calls = raw.resume.mock.calls.length;
    expect(await framed.receive()).toBeNull(); expect(raw.resume).toHaveBeenCalledTimes(calls);
    expect(raw.maxReadBufferLength).toBe(STREAM_LIMITS.readBufferBytes);
    expect(raw.maxWriteBufferLength).toBe(STREAM_LIMITS.writeBufferBytes);
  });

  it.each([new Uint8Array([0]), new Uint8Array([0, 0, 0]), new Uint8Array([0, 0, 0, 2, 42])])(
    'resets truncated headers/bodies instead of treating them as clean EOF', async chunk => {
      const raw = new ByteFixture(); raw.chunks = [chunk];
      const framed = new FramedStream(raw);
      await expect(framed.receive()).rejects.toMatchObject({ code: 'protocol' });
      expect(raw.abort).toHaveBeenCalledOnce();
      await expect(framed.send(new Uint8Array())).rejects.toMatchObject({ code: 'protocol' });
    });

  it('rejects a huge announced length without fetching or allocating its body', async () => {
    const raw = new ByteFixture(); raw.chunks = [new Uint8Array([255, 255, 255, 255])];
    await expect(new FramedStream(raw).receive()).rejects.toMatchObject({ code: 'limit' });
    expect(raw.resume).toHaveBeenCalledOnce(); expect(raw.abort).toHaveBeenCalledOnce();
  });

  it.each([0, STREAM_LIMITS.readBufferBytes + 1])('rejects an invalid underlying chunk size %s', async size => {
    const raw = new ByteFixture(); raw.chunks = [new Uint8Array(size)];
    await expect(new FramedStream(raw).receive()).rejects.toMatchObject({ code: 'limit' });
  });

  it('snapshots caller bytes before waiting and refuses oversized/shared input', async () => {
    const raw = new ByteFixture(), framed = new FramedStream(raw);
    const input = new Uint8Array([42]); const sending = framed.send(input); input[0] = 99;
    await sending; expect(raw.sent[0]).toEqual(wire(new Uint8Array([42])));
    await expect(framed.send(new Uint8Array(STREAM_LIMITS.frameBytes + 1))).rejects.toMatchObject({ code: 'limit' });
    await expect(framed.send(new Uint8Array(new SharedArrayBuffer(1)))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(raw.send).toHaveBeenCalledOnce();
  });

  it('waits for pre-existing backpressure, and never queues a concurrent send/finish', async () => {
    const raw = new ByteFixture(), framed = new FramedStream(raw);
    raw.writableNeedsDrain = true;
    const sending = framed.send(new Uint8Array([1])); await Promise.resolve();
    expect(raw.send).not.toHaveBeenCalled();
    await expect(framed.send(new Uint8Array())).rejects.toMatchObject({ code: 'busy' });
    await expect(framed.finish()).rejects.toMatchObject({ code: 'busy' });
    raw.writableNeedsDrain = false; raw.dispatchEvent(new Event('drain')); await sending;
    expect(raw.send).toHaveBeenCalledOnce();
  });

  it('honors send(false) and times out stalled drain without re-sending', async () => {
    vi.useFakeTimers();
    const raw = new ByteFixture(), framed = new FramedStream(raw);
    raw.send.mockImplementation(() => { raw.writableNeedsDrain = true; return false; });
    const sending = expect(framed.send(new Uint8Array([1]))).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(STREAM_LIMITS.operationMs); await sending;
    expect(raw.send).toHaveBeenCalledOnce(); expect(raw.abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for fresh drain events on every send, even after a previous drain resolved', async () => {
    const raw = new ByteFixture(), framed = new FramedStream(raw);
    raw.send.mockImplementation(() => { raw.writableNeedsDrain = true; return false; });
    for (let i = 0; i < 3; i++) {
      let finished = false;
      const sending = framed.send(new Uint8Array([i])).then(() => { finished = true; });
      await Promise.resolve(); await Promise.resolve();
      // A drain event is only a hint; if transport work refills the buffer, wait again.
      raw.dispatchEvent(new Event('drain'));
      await Promise.resolve(); expect(finished).toBe(false);
      raw.writableNeedsDrain = false; raw.dispatchEvent(new Event('drain'));
      await sending;
    }
    expect(raw.send).toHaveBeenCalledTimes(3);
  });

  it('bounds a stalled whole-frame receive and rejects overlapping reads', async () => {
    vi.useFakeTimers();
    const raw = new ByteFixture(); raw.eof = false; raw.chunks = [new Uint8Array([0, 0, 0, 2, 1])];
    const framed = new FramedStream(raw);
    const waiting = expect(framed.receive()).rejects.toMatchObject({ code: 'timeout' });
    await expect(framed.receive()).rejects.toMatchObject({ code: 'busy' });
    await vi.advanceTimersByTimeAsync(STREAM_LIMITS.operationMs - 1);
    expect(raw.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await waiting;
    expect(raw.abort).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('redacts transport errors and keeps a failed session terminal', async () => {
    const raw = new ByteFixture(), framed = new FramedStream(raw);
    raw.send.mockImplementation(() => { throw new Error('fixture private payload'); });
    await expect(framed.send(new Uint8Array())).rejects.toMatchObject({ message: 'Peer stream: io', code: 'io' });
    await expect(framed.receive()).rejects.toMatchObject({ code: 'io' });
  });

  it('half-closes writing idempotently while allowing reads', async () => {
    const raw = new ByteFixture(); raw.chunks = [wire(new Uint8Array([5]))];
    const framed = new FramedStream(raw);
    await framed.finish(); await framed.finish(); expect(raw.close).toHaveBeenCalledOnce();
    await expect(framed.send(new Uint8Array())).rejects.toMatchObject({ code: 'closed' });
    expect(await framed.receive()).toEqual(new Uint8Array([5]));
    expect(await framed.receive()).toBeNull();
  });

  it('bounds a stalled graceful close', async () => {
    vi.useFakeTimers(); const raw = new ByteFixture(), framed = new FramedStream(raw);
    raw.close.mockImplementation(async () => await new Promise<void>(() => {}));
    const closing = expect(framed.finish()).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(STREAM_LIMITS.closeMs); await closing;
    expect(raw.abort).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['records', 'bytes'] as const)('enforces both inbound and outbound session %s limits', async kind => {
    const raw = new ByteFixture(), framed = new FramedStream(raw);
    const bytes = new Uint8Array(kind === 'bytes' ? STREAM_LIMITS.frameBytes : 0);
    const count = kind === 'bytes' ? STREAM_LIMITS.bytesPerDirection / bytes.length : STREAM_LIMITS.framesPerDirection;
    for (let i = 0; i < count; i++) {
      raw.chunks.push(wire(bytes)); await framed.send(bytes); await framed.receive();
      raw.sent.length = 0;
    }
    await expect(framed.send(kind === 'bytes' ? new Uint8Array([1]) : bytes)).rejects.toMatchObject({ code: 'limit' });
    raw.chunks.push(wire(kind === 'bytes' ? new Uint8Array([1]) : bytes));
    await expect(framed.receive()).rejects.toMatchObject({ code: 'limit' });
  });

  it('aborts a timed-out operation signal and clears successful deadline timers', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const stalled = expect(withDeadline(async next => { signal = next; return await new Promise(() => {}); }, 10))
      .rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10); await stalled; expect(signal?.aborted).toBe(true);
    expect(await withDeadline(async () => 42, 10)).toBe(42); expect(vi.getTimerCount()).toBe(0);
  });
});
