import type { MessageEnvelope } from '@openagentforum/protocol';

/** Relay input policy v1, not a protocol change or an aggregate admission budget. */
export const PUBLIC_WRITE_LIMITS = Object.freeze({
  channelBytes: 16 * 1024, messageBytes: 256 * 1024, taskCreateBytes: 48 * 1024,
  taskClaimBytes: 4 * 1024, taskSubmitBytes: 256 * 1024,
  readTimeoutMs: 5000, reads: 4096, depth: 16, nodes: 8192, entries: 1024,
  propertyLength: 256, identifierLength: 256, channelLength: 128, typeLength: 64,
  channelTitleLength: 256, channelTopicLength: 4096, recipients: 64,
});
export const TASK_CREATE_LIMITS = Object.freeze({
  title: 160, description: 6000, reward: 512, capabilities: 16,
  minTimeoutMs: 60000, maxTimeoutMs: 86400000, bodyBytes: PUBLIC_WRITE_LIMITS.taskCreateBytes,
});

interface ChannelInput {
  name: string; title: string; topic?: string; creatorId?: string;
  isPrivate?: boolean; e2eeRequired?: boolean; allowedAgents?: unknown;
}
interface TaskProof { agentId: string; signature?: string; timestamp?: number }
interface TaskCreatePayload {
  title: string; description: string; requiredCapabilities?: string[];
  timeoutMs?: number; reward?: string | null;
}
interface WriteInputs {
  channel: ChannelInput;
  message: MessageEnvelope<unknown>;
  'task-create': TaskCreatePayload & { creatorId: string; signature?: string; timestamp?: number };
  'task-claim': TaskProof;
  'task-submit': TaskProof & { resultPayload: unknown };
}
export type PublicWriteKind = keyof WriteInputs;
const bodyBytes: Record<PublicWriteKind, number> = {
  channel: PUBLIC_WRITE_LIMITS.channelBytes, message: PUBLIC_WRITE_LIMITS.messageBytes,
  'task-create': PUBLIC_WRITE_LIMITS.taskCreateBytes, 'task-claim': PUBLIC_WRITE_LIMITS.taskClaimBytes,
  'task-submit': PUBLIC_WRITE_LIMITS.taskSubmitBytes,
};
const codes = { 400: 'invalid_public_input', 408: 'public_input_timeout',
  413: 'public_input_too_large', 415: 'unsupported_public_input' } as const;
export class PublicWriteInputError extends Error {
  readonly code: typeof codes[keyof typeof codes];
  constructor(readonly status: keyof typeof codes) {
    super(codes[status]); this.code = codes[status];
  }
  /** Also understood by Hono's default error handler; never includes request data. */
  getResponse(): Response {
    return new Response(JSON.stringify({ error: this.code, code: this.code }), { status: this.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
  }
}
function requireInput(condition: unknown, status: keyof typeof codes = 400): asserts condition {
  if (!condition) throw new PublicWriteInputError(status);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number, empty = false): value is string {
  // Do not apply this field policy to arbitrary signed payload strings: canonical
  // JSON v1 explicitly supports escaped lone surrogates in payloads and keys.
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= max
    && !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const agentId = (value: unknown) => typeof value === 'string' && /^agent_[0-9a-f]{16}$/.test(value);
const hex = (value: unknown, length: number) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/i.test(value);

/** Shared with the source-checkout partner publisher. Never change signed fields. */
export function validTaskCreatePayload(value: unknown): value is TaskCreatePayload {
  if (!object(value)) return false;
  const { title, description, reward = null, requiredCapabilities = [], timeoutMs = 3600000 } = value;
  return text(title, TASK_CREATE_LIMITS.title) && text(description, TASK_CREATE_LIMITS.description)
    && (reward === null || text(reward, TASK_CREATE_LIMITS.reward))
    && Array.isArray(requiredCapabilities) && requiredCapabilities.length <= TASK_CREATE_LIMITS.capabilities
    && requiredCapabilities.every(c => typeof c === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:+-]{0,63}$/.test(c))
    && typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs)
    && timeoutMs >= TASK_CREATE_LIMITS.minTimeoutMs && timeoutMs <= TASK_CREATE_LIMITS.maxTimeoutMs;
}

/** Reject excessive nesting before JSON.parse, respecting string escape sequences. */
function boundNesting(raw: string): void {
  let depth = 0, quoted = false, escaped = false;
  for (const char of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') requireInput(++depth <= PUBLIC_WRITE_LIMITS.depth, 413);
    else if (char === '}' || char === ']') depth--;
  }
}
/** Bound every field, including ignored extensions, before recursive canonicalization. */
function boundTree(root: unknown): void {
  const pending = [root];
  let nodes = 0;
  while (pending.length) {
    const value = pending.pop();
    requireInput(++nodes <= PUBLIC_WRITE_LIMITS.nodes, 413);
    if (typeof value === 'number') requireInput(Number.isFinite(value));
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value);
      requireInput(keys.length <= PUBLIC_WRITE_LIMITS.entries, 413);
      for (const key of keys) {
        requireInput(key.length <= PUBLIC_WRITE_LIMITS.propertyLength, 413);
        pending.push((value as Record<string, unknown>)[key]);
      }
      requireInput(nodes + pending.length <= PUBLIC_WRITE_LIMITS.nodes, 413);
    }
  }
}

function validate<K extends PublicWriteKind>(value: Record<string, unknown>, kind: K, destination?: string): asserts value is Record<string, unknown> & WriteInputs[K] {
  if (kind === 'channel') {
    requireInput(text(value.name, PUBLIC_WRITE_LIMITS.channelLength) && text(value.title, PUBLIC_WRITE_LIMITS.channelTitleLength));
    if (value.topic !== undefined) requireInput(text(value.topic, PUBLIC_WRITE_LIMITS.channelTopicLength, true));
    if (value.creatorId !== undefined) requireInput(text(value.creatorId, PUBLIC_WRITE_LIMITS.identifierLength));
    // Existing handlers retain their explicit 501 for unsupported membership and
    // their privacy/encryption checks; this reader never supplies room authority.
  } else if (kind === 'message') {
    requireInput(text(value.id, PUBLIC_WRITE_LIMITS.identifierLength) && agentId(value.sender)
      && text(value.channel, PUBLIC_WRITE_LIMITS.channelLength) && value.channel === destination
      && text(value.type, PUBLIC_WRITE_LIMITS.typeLength) && integer(value.sequence) && integer(value.timestamp)
      && hex(value.signature, 128) && hex(value.checksum, 64) && Object.hasOwn(value, 'payload'));
    if (typeof value.replyToId === 'string') requireInput(value.replyToId.length <= PUBLIC_WRITE_LIMITS.identifierLength, 413);
    if (object(value.recipientKeys)) requireInput(Object.keys(value.recipientKeys).length <= PUBLIC_WRITE_LIMITS.recipients, 413);
  } else {
    if (kind === 'task-create') requireInput(validTaskCreatePayload(value) && agentId(value.creatorId));
    else requireInput(agentId(value.agentId));
    // Missing proof fields still reach the existing 401 authentication response.
    if (value.signature !== undefined) requireInput(typeof value.signature === 'string' && /^[0-9a-f]{128}$/.test(value.signature));
    if (value.timestamp !== undefined) requireInput(integer(value.timestamp));
    if (kind === 'task-submit') requireInput(Object.hasOwn(value, 'resultPayload'));
  }
}

/** Single bounded read; no clones, normalization, retries, storage or cryptography. */
export async function readPublicWriteInput<K extends PublicWriteKind>(request: Request, kind: K, destination?: string): Promise<WriteInputs[K]> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (kind === 'message') requireInput(text(destination, PUBLIC_WRITE_LIMITS.channelLength));
    if (kind === 'task-claim' || kind === 'task-submit') requireInput(text(destination, PUBLIC_WRITE_LIMITS.identifierLength));
    const encoding = request.headers.get('content-encoding');
    requireInput(encoding === null || encoding.trim().toLowerCase() === 'identity', 415);
    requireInput(/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(request.headers.get('content-type') ?? ''), 415);
    const declared = request.headers.get('content-length');
    if (declared !== null) {
      requireInput(/^[0-9]+$/.test(declared));
      requireInput(Number(declared) <= bodyBytes[kind], 413);
    }
    requireInput(request.body && !request.body.locked && !request.signal.aborted);
    reader = request.body.getReader();
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PublicWriteInputError(408)), PUBLIC_WRITE_LIMITS.readTimeoutMs);
      onAbort = () => reject(new PublicWriteInputError(400));
      request.signal.addEventListener('abort', onAbort, { once: true });
    });
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let raw = '', bytes = 0;
    for (let reads = 0; ; reads++) {
      requireInput(reads < PUBLIC_WRITE_LIMITS.reads);
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      bytes += value.byteLength;
      requireInput(bytes <= bodyBytes[kind], 413);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    boundNesting(raw);
    const value: unknown = JSON.parse(raw);
    requireInput(object(value));
    boundTree(value);
    validate(value, kind, destination);
    return value;
  } catch (error) {
    if (error instanceof PublicWriteInputError) throw error;
    throw new PublicWriteInputError(400);
  } finally {
    clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener('abort', onAbort);
    // A stalled/uncooperative producer must not delay the rejection response.
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
  }
}
