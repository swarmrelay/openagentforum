// Bounded local stdio only. No network, identity, callbacks selected by input or shell execution.
export const CLI_LIMITS = Object.freeze({ lineBytes: 32768, totalBytes: 8 * 1024 * 1024,
  commands: 4096, idleMs: 30000, writeMs: 5000, lifetimeMs: 360000 });
export class CliIoError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function bounded(promise, milliseconds, signal, cancel) {
  if (signal?.aborted) {
    // The supplied operation may already be in flight. Observe its eventual
    // rejection even when cancellation wins before the race is installed.
    Promise.resolve(promise).catch(() => {});
    cancel(); return Promise.reject(new CliIoError('interrupted'));
  }
  let timer, abort;
  const stopped = new Promise((_, reject) => {
    const stop = code => { cancel(); reject(new CliIoError(code)); };
    timer = setTimeout(() => stop('stdio_deadline'), milliseconds);
    abort = () => stop('interrupted'); signal?.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, stopped]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}
export function createLineReader(input, signal, limits = CLI_LIMITS) {
  const iterator = input[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0), total = 0, reads = 0;
  return async () => {
    const until = performance.now() + limits.idleMs;
    for (;;) {
      signal?.throwIfAborted();
      const newline = buffer.indexOf(10);
      if (newline >= 0) {
        if (newline > limits.lineBytes) throw new CliIoError('input_limit');
        let line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
        if (line.at(-1) === 13) line = line.subarray(0, -1);
        try {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line));
          if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
          return value;
        }
        catch { throw new CliIoError('invalid_json'); }
      }
      if (buffer.length > limits.lineBytes || ++reads > 65536) throw new CliIoError('input_limit');
      const wait = until - performance.now(); if (wait <= 0) throw new CliIoError('stdio_deadline');
      const result = await bounded(iterator.next(), wait, signal, () => input.destroy());
      if (result.done) {
        if (buffer.length) throw new CliIoError('incomplete_line');
        return null;
      }
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array) || chunk.length > 65536 || (total += chunk.length) > limits.totalBytes) throw new CliIoError('input_limit');
      buffer = Buffer.concat([buffer, chunk]);
    }
  };
}
export function createWriter(output, signal, limits = CLI_LIMITS) {
  let total = 0;
  return async value => {
    if (signal?.aborted) throw new CliIoError('interrupted');
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > limits.lineBytes || (total += bytes.length) > limits.totalBytes) throw new CliIoError('output_limit');
    const write = new Promise((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve()));
    await bounded(write, limits.writeMs, signal, () => output.destroy());
  };
}
