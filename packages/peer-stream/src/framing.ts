/** Bounded records over an ALREADY authenticated/encrypted stream. No cryptography here. */
import type { Stream, StreamMessageEvent, StreamCloseEvent } from '@libp2p/interface';
type ByteStream = Pick<Stream, 'send' | 'close' | 'abort' | 'pause' | 'resume' | 'readableEnded'
  | 'readBufferLength' | 'status' | 'writableNeedsDrain' | 'maxReadBufferLength' | 'maxWriteBufferLength' | 'inactivityTimeout'>
  & Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export const STREAM_LIMITS = Object.freeze({ frameBytes: 16_384, framesPerDirection: 1024,
  bytesPerDirection: 4_194_304, readBufferBytes: 262_144, writeBufferBytes: 65_536,
  operationMs: 5000, sessionMs: 60_000, closeMs: 1000 });
export type StreamFailureCode = 'invalid_input' | 'busy' | 'closed' | 'timeout' | 'limit' | 'protocol' | 'io' | 'peer';
export class StreamFailure extends Error {
  constructor(readonly code: StreamFailureCode) { super(`Peer stream: ${code}`); this.name = 'StreamFailure'; }
}

/** Races a deadline without leaking the timer or an unhandled rejection. */
export async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new StreamFailure('timeout')); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

export class FramedStream {
  readonly #stream: ByteStream;
  #waiting: { resolve: (chunk: Uint8Array | null) => void; reject: (error: Error) => void } | null = null;
  #inputEnded = false;
  #resuming = false;
  #chunk: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #reading = false;
  #writing = false;
  #finished = false;
  #ended = false;
  #failure: StreamFailure | null = null;
  #sentFrames = 0;
  #receivedFrames = 0;
  #sentBytes = 0;
  #receivedBytes = 0;

  constructor(stream: ByteStream) {
    this.#stream = stream;
    stream.maxReadBufferLength = STREAM_LIMITS.readBufferBytes;
    stream.maxWriteBufferLength = STREAM_LIMITS.writeBufferBytes;
    stream.inactivityTimeout = STREAM_LIMITS.operationMs;
    this.#inputEnded = stream.readableEnded;
    stream.addEventListener('message', this.#onMessage);
    stream.addEventListener('end', this.#onEnd);
    stream.addEventListener('close', this.#onClose);
    if (stream.status === 'aborted' || stream.status === 'reset') this.abort('io');
    else if (!this.#inputEnded) stream.pause();
  }
  // Do NOT use libp2p's convenience async iterator: its pushable queue is unbounded.
  // Pause synchronously on each delivery, and resume only for one explicit pull.
  readonly #onMessage = (event: Event): void => {
    try {
      // resume() dispatches buffered data before restoring Yamux's window state.
      // In that synchronous case, pause immediately AFTER resume() returns.
      if (!this.#resuming) this.#stream.pause();
      const data = (event as StreamMessageEvent).data;
      if (data.byteLength < 1 || data.byteLength > STREAM_LIMITS.readBufferBytes) { this.abort('limit'); return; }
      if (!this.#waiting) { this.abort('protocol'); return; }
      const chunk = data.subarray();
      const waiting = this.#waiting; this.#waiting = null;
      waiting.resolve(chunk);
    } catch { this.abort('io'); }
  };
  readonly #onEnd = (): void => {
    if (this.#stream.status === 'aborted' || this.#stream.status === 'reset') { this.abort('io'); return; }
    this.#inputEnded = true;
    this.#waiting?.resolve(null); this.#waiting = null;
  };
  readonly #onClose = (event: Event): void => {
    if ((event as StreamCloseEvent).error) this.abort('io');
    else if (this.#stream.readBufferLength === 0) this.#onEnd();
  };
  #next(): Promise<Uint8Array | null> {
    if (this.#inputEnded) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
      this.#resuming = true;
      try {
        this.#stream.resume();
        if (!this.#waiting && !this.#inputEnded && !this.#failure) this.#stream.pause();
      } catch { this.abort('io'); }
      finally { this.#resuming = false; }
    });
  }
  #check() { if (this.#failure) throw this.#failure; }
  abort(code: StreamFailureCode = 'closed'): void {
    if (this.#failure) return;
    this.#failure = new StreamFailure(code);
    this.#chunk = new Uint8Array(0); this.#offset = 0;
    this.#waiting?.reject(this.#failure); this.#waiting = null;
    this.#stream.removeEventListener('message', this.#onMessage);
    this.#stream.removeEventListener('end', this.#onEnd);
    this.#stream.removeEventListener('close', this.#onClose);
    this.#stream.abort(this.#failure);
  }
  #failed(error: unknown): never {
    this.abort(error instanceof StreamFailure ? error.code : 'io');
    throw this.#failure;
  }
  async #drain(signal: AbortSignal): Promise<void> {
    // This pinned libp2p utils version caches onDrain()'s first resolved promise.
    // Use fresh events and recheck after the muxer's queued send work instead.
    while (this.#stream.writableNeedsDrain) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.#stream.removeEventListener('drain', drained);
          this.#stream.removeEventListener('close', closed);
          signal.removeEventListener('abort', cancelled);
        };
        const drained = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new StreamFailure('io')); };
        const cancelled = () => { cleanup(); reject(new StreamFailure('timeout')); };
        this.#stream.addEventListener('drain', drained);
        this.#stream.addEventListener('close', closed);
        signal.addEventListener('abort', cancelled, { once: true });
        if (signal.aborted) cancelled();
        else if (!this.#stream.writableNeedsDrain) drained();
      });
      this.#check();
    }
  }
  /** One outstanding send; completion means handed to transport, NOT peer processing. */
  async send(bytes: Uint8Array): Promise<void> {
    this.#check();
    if (this.#writing) throw new StreamFailure('busy');
    if (this.#finished) throw new StreamFailure('closed');
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) throw new StreamFailure('invalid_input');
    if (bytes.byteLength > STREAM_LIMITS.frameBytes || this.#sentFrames >= STREAM_LIMITS.framesPerDirection
        || this.#sentBytes + bytes.byteLength > STREAM_LIMITS.bytesPerDirection) throw new StreamFailure('limit');
    // Snapshot before any await. No caller-owned buffer is kept by the transport.
    const frame = new Uint8Array(4 + bytes.byteLength);
    new DataView(frame.buffer).setUint32(0, bytes.byteLength); frame.set(bytes, 4);
    this.#writing = true; this.#sentFrames++; this.#sentBytes += bytes.byteLength;
    try {
      await withDeadline(async signal => {
        await this.#drain(signal);
        this.#check();
        if (!this.#stream.send(frame)) await this.#drain(signal);
        this.#check();
      }, STREAM_LIMITS.operationMs);
    } catch (error) { this.#failed(error); }
    finally { this.#writing = false; }
  }
  async #exact(length: number, cleanEof: boolean): Promise<Uint8Array | null> {
    const result = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      this.#check();
      if (this.#offset === this.#chunk.byteLength) {
        this.#chunk = new Uint8Array(0); this.#offset = 0;
        const next = await this.#next();
        this.#check();
        if (next === null) {
          if (filled === 0 && cleanEof) return null;
          throw new StreamFailure('protocol');
        }
        this.#chunk = next; // one bounded chunk; no background queue or unbounded concatenation
      }
      const count = Math.min(length - filled, this.#chunk.byteLength - this.#offset);
      result.set(this.#chunk.subarray(this.#offset, this.#offset + count), filled);
      this.#offset += count; filled += count;
    }
    return result;
  }
  /** One outstanding receive; deadline covers a WHOLE frame, not each fragment. */
  async receive(): Promise<Uint8Array | null> {
    this.#check();
    if (this.#reading) throw new StreamFailure('busy');
    if (this.#ended) return null;
    this.#reading = true;
    try {
      return await withDeadline(async () => {
        const header = await this.#exact(4, true);
        if (header === null) { this.#ended = true; return null; }
        const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0);
        if (length > STREAM_LIMITS.frameBytes || this.#receivedFrames >= STREAM_LIMITS.framesPerDirection
            || this.#receivedBytes + length > STREAM_LIMITS.bytesPerDirection) throw new StreamFailure('limit');
        this.#receivedFrames++; this.#receivedBytes += length;
        return await this.#exact(length, false);
      }, STREAM_LIMITS.operationMs);
    } catch (error) { return this.#failed(error); }
    finally { this.#reading = false; }
  }
  /** Half-close writing after pending transport bytes drain. Continue receiving until EOF. */
  async finish(): Promise<void> {
    this.#check();
    if (this.#writing) throw new StreamFailure('busy');
    if (this.#finished) return;
    this.#writing = true; this.#finished = true;
    try { await withDeadline(signal => this.#stream.close({ signal }), STREAM_LIMITS.closeMs); this.#check(); }
    catch (error) { this.#failed(error); }
    finally { this.#writing = false; }
  }
}
