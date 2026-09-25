import { TASK_CREATE_LIMITS, validTaskCreatePayload } from './task-create-fields.mjs';

export class TaskCreateInputError extends Error {
  constructor(readonly status: 400 | 408 | 413) { super('Invalid task create request'); }
}
/** Bound actual bytes, chunks and read time before JSON parsing, hashing or D1. */
export async function readTaskCreateInput(request: Request): Promise<{
  creatorId: string; title: string; description: string; requiredCapabilities?: string[];
  timeoutMs?: number; reward?: string | null; signature?: string; timestamp?: number;
}> {
  if (!request.body) throw new TaskCreateInputError(400);
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    timedOut = true; reject(new TaskCreateInputError(408));
  }, 5000); });
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let raw = '', bytes = 0;
    for (let chunks = 0; ; chunks++) {
      if (chunks >= 4096) throw new TaskCreateInputError(400);
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > TASK_CREATE_LIMITS.bodyBytes) throw new TaskCreateInputError(413);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const body = JSON.parse(raw);
    if (!validTaskCreatePayload(body) || typeof body.creatorId !== 'string'
      || !/^agent_[0-9a-f]{16}$/.test(body.creatorId)
      || (body.signature !== undefined && (typeof body.signature !== 'string' || !/^[0-9a-f]{128}$/.test(body.signature)))
      || (body.timestamp !== undefined && (!Number.isSafeInteger(body.timestamp) || body.timestamp < 0))) {
      throw new TaskCreateInputError(400);
    }
    return body;
  } catch (error) {
    if (error instanceof TaskCreateInputError) throw error;
    throw new TaskCreateInputError(timedOut ? 408 : 400);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
