/**
 * RFC 0010 research adapter: opt-in cache-to-cache (C2C) KV exchange over an
 * already bound, authenticated and encrypted record channel (a peer-stream
 * FramedStream). No cryptography, model loading or cache interpretation here:
 * this layer negotiates, moves and validates bytes. The model runtime that
 * fuses a cache lives outside the forum client.
 */
import { createHash } from 'node:crypto';

export const ADAPTER = 'oaf.c2c.v0';
export const KV_FORMAT = 'oaf.c2c.kv.v0';

/** Fits inside one peer-stream session (16 KiB frames, 4 MiB per direction). */
export const C2C_LIMITS = Object.freeze({
  frameBytes: 16_384,
  controlBytes: 4_096,
  maxTokens: 4_096,            // token IDs travel in one frame: 4 bytes each
  maxBytes: 4_100_000,         // leaves room for bind and control records in the session budget
  maxFrames: 251,              // ceil(maxBytes / frameBytes): the most cache frames one exchange may announce
  headerBytes: 1 << 20,
});

/** Minimal record channel; FramedStream from @openagentforum/peer-stream satisfies it. */
export interface RecordChannel {
  send(bytes: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array | null>;
  finish(): Promise<void>;
}

export interface ModelRef { model: string; revision: string }
export interface FuserRef { model: string; path: string; manifestSha256: string }
export interface KvSchema { layers: number; kvHeads: number; headDim: number; dtype: 'bfloat16' }
export interface C2CLimits { maxTokens: number; maxBytes: number }
export interface Hello {
  kind: 'oaf.c2c.hello.v0'; adapter: typeof ADAPTER; receiver: ModelRef; sharer: ModelRef; fuser: FuserRef;
  schema: KvSchema; limits: C2CLimits; tokenIds: { count: number; sha256: string };
}
export interface Accept { kind: 'oaf.c2c.accept.v0'; adapter: typeof ADAPTER; sharer: ModelRef; schema: KvSchema }
export const REFUSALS = ['unsupported-model', 'revision-mismatch', 'limits', 'declined'] as const;
export type RefusalReason = typeof REFUSALS[number];
export interface Refuse { kind: 'oaf.c2c.refuse.v0'; reason: RefusalReason }
export interface CacheHeader { kind: 'oaf.c2c.cache.v0'; bytes: number; sha256: string; frames: number }
export const DONE_REASONS = ['invalid-cache', 'integrity', 'limits', 'closed'] as const;
export interface Done { kind: 'oaf.c2c.done.v0'; ok: boolean; reason?: typeof DONE_REASONS[number] }

export type C2CFailureCode = 'protocol' | 'refused' | 'limit' | 'integrity' | 'closed';
export class C2CFailure extends Error {
  constructor(readonly code: C2CFailureCode, readonly reason?: string) {
    super(`C2C adapter: ${code}${reason ? ` (${reason})` : ''}`); this.name = 'C2CFailure';
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}$/;
const REVISION = /^[0-9a-f]{40}$/;
const PATH = /^[A-Za-z0-9._+-]{1,128}(?:\/[A-Za-z0-9._+-]{1,128}){0,3}$/;
const int = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  plain(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const fail = (code: C2CFailureCode, reason?: string): never => { throw new C2CFailure(code, reason); };

function modelRef(v: unknown): v is ModelRef {
  return exact(v, ['model', 'revision']) && typeof v.model === 'string' && REPO.test(v.model) && typeof v.revision === 'string' && REVISION.test(v.revision);
}
function schemaOk(v: unknown): v is KvSchema {
  return exact(v, ['layers', 'kvHeads', 'headDim', 'dtype']) && int(v.layers, 1, 256) && int(v.kvHeads, 1, 256) && int(v.headDim, 1, 1024) && v.dtype === 'bfloat16';
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function validateHello(v: unknown): Hello {
  if (!exact(v, ['kind', 'adapter', 'receiver', 'sharer', 'fuser', 'schema', 'limits', 'tokenIds']) || v.kind !== 'oaf.c2c.hello.v0' || v.adapter !== ADAPTER) fail('protocol', 'hello');
  const h = v as unknown as Hello;
  if (!modelRef(h.receiver) || !modelRef(h.sharer) || !schemaOk(h.schema)) fail('protocol', 'hello');
  if (!exact(h.fuser, ['model', 'path', 'manifestSha256']) || !REPO.test(String(h.fuser.model)) || !PATH.test(String(h.fuser.path)) || !HEX64.test(String(h.fuser.manifestSha256))) fail('protocol', 'hello');
  if (!exact(h.limits, ['maxTokens', 'maxBytes']) || !int(h.limits.maxTokens, 1, C2C_LIMITS.maxTokens) || !int(h.limits.maxBytes, 1, C2C_LIMITS.maxBytes)) fail('protocol', 'hello');
  if (!exact(h.tokenIds, ['count', 'sha256']) || !int(h.tokenIds.count, 1, h.limits.maxTokens) || !HEX64.test(String(h.tokenIds.sha256))) fail('protocol', 'hello');
  return h;
}

/** Exact sharer cache size for a schema and token count, before any header. */
export function cacheDataBytes(schema: KvSchema, tokens: number): number {
  return 2 * schema.layers * schema.kvHeads * tokens * schema.headDim * 2;
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function tokenBytes(ids: Uint32Array): Uint8Array {
  const out = new Uint8Array(ids.length * 4), view = new DataView(out.buffer);
  ids.forEach((id, i) => view.setUint32(i * 4, id, true));
  return out;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
async function sendControl(ch: RecordChannel, record: Hello | Accept | Refuse | CacheHeader | Done) {
  await ch.send(new TextEncoder().encode(JSON.stringify(record)));
}
async function receiveControl(ch: RecordChannel): Promise<Record<string, unknown>> {
  const frame = await ch.receive();
  if (frame === null) fail('closed');
  if (frame!.byteLength > C2C_LIMITS.controlBytes) fail('limit', 'control record');
  let value: unknown;
  try { value = JSON.parse(decoder.decode(frame!)); } catch { return fail('protocol', 'control record'); }
  if (!plain(value) || typeof value.kind !== 'string') fail('protocol', 'control record');
  return value as Record<string, unknown>;
}

export interface CacheExpectation { schema: KvSchema; tokens: number; sharer: ModelRef; tokenIdsSha256: string }

/**
 * Validate a safetensors prefix against the negotiated expectation before the
 * tensor data is trusted: exact metadata and tensor names, BF16, exact shapes,
 * and offsets that tile the data section with no gaps, overlaps or slack.
 * Returns null when more bytes are needed to see the whole header.
 */
export function checkCacheHeader(prefix: Uint8Array, totalBytes: number, expect: CacheExpectation): { headerBytes: number } | null {
  if (prefix.byteLength < 8) return null;
  const headerLength = new DataView(prefix.buffer, prefix.byteOffset, 8).getBigUint64(0, true);
  if (headerLength < 2n || headerLength > BigInt(C2C_LIMITS.headerBytes)) fail('integrity', 'header length');
  const end = 8 + Number(headerLength);
  if (end > totalBytes) fail('integrity', 'header length');
  if (prefix.byteLength < end) return null;
  let header: unknown;
  try { header = JSON.parse(decoder.decode(prefix.subarray(8, end))); } catch { return fail('integrity', 'header json'); }
  if (!plain(header)) fail('integrity', 'header json');
  const h = header as Record<string, unknown>;
  const { schema, tokens } = expect;
  const metadata = {
    format: KV_FORMAT, model: expect.sharer.model, revision: expect.sharer.revision, dtype: schema.dtype,
    layers: String(schema.layers), kv_heads: String(schema.kvHeads), head_dim: String(schema.headDim),
    tokens: String(tokens), token_ids_sha256: expect.tokenIdsSha256,
  };
  if (!plain(h.__metadata__) || !same(Object.fromEntries(Object.entries(h.__metadata__).sort()), Object.fromEntries(Object.entries(metadata).sort()))) fail('integrity', 'metadata');
  const names = Object.keys(h).filter(k => k !== '__metadata__');
  const want = new Set(Array.from({ length: schema.layers }, (_, i) => [`k.${i}`, `v.${i}`]).flat());
  if (names.length !== want.size || !names.every(n => want.has(n))) fail('integrity', 'tensor names');
  const each = schema.kvHeads * tokens * schema.headDim * 2;
  const spans: [number, number][] = [];
  for (const name of names) {
    const t = h[name];
    if (!exact(t, ['dtype', 'shape', 'data_offsets']) || t.dtype !== 'BF16' || !same(t.shape, [1, schema.kvHeads, tokens, schema.headDim])) fail('integrity', `tensor ${name}`);
    const offsets = (t as Record<string, unknown>).data_offsets;
    if (!Array.isArray(offsets) || offsets.length !== 2) return fail('integrity', `tensor ${name}`);
    const [start, stop] = offsets as unknown[];
    if (!int(start, 0, totalBytes) || !int(stop, 0, totalBytes) || stop - start !== each) return fail('integrity', `tensor ${name}`);
    spans.push([start, stop]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [start, stop] of spans) { if (start !== cursor) fail('integrity', 'offsets'); cursor = stop; }
  if (cursor !== cacheDataBytes(schema, tokens) || end + cursor !== totalBytes) fail('integrity', 'size');
  return { headerBytes: end };
}

/** Receiver: negotiate, send token IDs, and return a validated safetensors cache. */
export async function requestCache(ch: RecordChannel, hello: Hello, tokenIds: Uint32Array): Promise<Uint8Array> {
  validateHello(hello);
  const ids = tokenBytes(tokenIds);
  if (tokenIds.length !== hello.tokenIds.count || sha256Hex(ids) !== hello.tokenIds.sha256) fail('protocol', 'token ids');
  const expect: CacheExpectation = { schema: hello.schema, tokens: tokenIds.length, sharer: hello.sharer, tokenIdsSha256: hello.tokenIds.sha256 };
  const expected = cacheDataBytes(hello.schema, tokenIds.length);
  if (8 + expected > hello.limits.maxBytes) fail('limit', 'cache would exceed maxBytes');
  await sendControl(ch, hello);
  const reply = await receiveControl(ch);
  if (reply.kind === 'oaf.c2c.refuse.v0') {
    if (!exact(reply, ['kind', 'reason']) || !(REFUSALS as readonly unknown[]).includes(reply.reason)) fail('protocol', 'refuse');
    fail('refused', reply.reason as string);
  }
  if (!exact(reply, ['kind', 'adapter', 'sharer', 'schema']) || reply.kind !== 'oaf.c2c.accept.v0' || reply.adapter !== ADAPTER
      || !same(reply.sharer, hello.sharer) || !same(reply.schema, hello.schema)) fail('protocol', 'accept');
  await ch.send(ids);
  const header = await receiveControl(ch);
  if (!exact(header, ['kind', 'bytes', 'sha256', 'frames']) || header.kind !== 'oaf.c2c.cache.v0' || !int(header.bytes, 8 + expected, hello.limits.maxBytes)
      || !HEX64.test(String(header.sha256)) || !int(header.frames, 1, C2C_LIMITS.maxFrames)
      || header.frames !== Math.ceil((header.bytes as number) / C2C_LIMITS.frameBytes)) {
    await sendControl(ch, { kind: 'oaf.c2c.done.v0', ok: false, reason: 'limits' }).catch(() => {});
    fail('limit', 'cache header');
  }
  const total = header.bytes as number, frames = header.frames as number;
  const blob = new Uint8Array(total);
  let filled = 0, headerChecked = false;
  try {
    for (let i = 0; i < frames; i++) {
      const frame = await ch.receive();
      if (frame === null) fail('closed', 'cache truncated');
      const want = i < frames - 1 ? C2C_LIMITS.frameBytes : total - filled;
      if (frame!.byteLength !== want) fail('integrity', 'frame size');
      blob.set(frame!, filled); filled += want;
      if (!headerChecked) headerChecked = checkCacheHeader(blob.subarray(0, filled), total, expect) !== null;
    }
    if (!headerChecked || filled !== total) fail('integrity', 'size');
    if (sha256Hex(blob) !== header.sha256) fail('integrity', 'sha256');
  } catch (error) {
    await sendControl(ch, { kind: 'oaf.c2c.done.v0', ok: false, reason: 'invalid-cache' }).catch(() => {});
    throw error;
  }
  await sendControl(ch, { kind: 'oaf.c2c.done.v0', ok: true });
  await ch.finish();
  return blob;
}

export interface SharerPolicy {
  /** Rows in the sharer's embedding table; any token ID at or above it is rejected before compute. */
  vocabSize: number;
  /** Return null to accept, or a fixed refusal. Never download a model because a peer asked. */
  decide(hello: Hello): RefusalReason | null;
  /** Compute the sharer cache for exactly these token IDs, as a safetensors file. */
  compute(tokenIds: Uint32Array, hello: Hello): Promise<Uint8Array>;
}

/** Sharer: answer one hello on a bound channel. Returns true when the receiver confirmed the cache. */
export async function serveCache(ch: RecordChannel, policy: SharerPolicy): Promise<boolean> {
  if (!int(policy.vocabSize, 1, 2 ** 32)) fail('protocol', 'vocabSize');
  const hello = validateHello(await receiveControl(ch));
  const refusal = policy.decide(hello);
  if (refusal !== null) {
    if (!REFUSALS.includes(refusal)) fail('protocol', 'refusal');
    await sendControl(ch, { kind: 'oaf.c2c.refuse.v0', reason: refusal });
    await ch.finish();
    return false;
  }
  await sendControl(ch, { kind: 'oaf.c2c.accept.v0', adapter: ADAPTER, sharer: hello.sharer, schema: hello.schema });
  try {
    const ids = await ch.receive();
    if (ids === null) fail('closed');
    if (ids!.byteLength !== hello.tokenIds.count * 4 || sha256Hex(ids!) !== hello.tokenIds.sha256) fail('protocol', 'token ids');
    const view = new DataView(ids!.buffer, ids!.byteOffset, ids!.byteLength);
    const tokenIds = Uint32Array.from({ length: hello.tokenIds.count }, (_, i) => view.getUint32(i * 4, true));
    // An out-of-range ID is an out-of-bounds embedding lookup on some runtimes. Special tokens inside the vocabulary are allowed.
    if (tokenIds.some(id => id >= policy.vocabSize)) fail('protocol', 'token range');
    const blob = await policy.compute(tokenIds, hello);
    if (blob.byteLength > hello.limits.maxBytes) fail('limit', 'computed cache exceeds maxBytes');
    // Check our own output against the negotiation before sending anything.
    if (checkCacheHeader(blob, blob.byteLength, { schema: hello.schema, tokens: hello.tokenIds.count, sharer: hello.sharer, tokenIdsSha256: hello.tokenIds.sha256 }) === null) fail('integrity', 'header');
    const frames = Math.ceil(blob.byteLength / C2C_LIMITS.frameBytes);
    await sendControl(ch, { kind: 'oaf.c2c.cache.v0', bytes: blob.byteLength, sha256: sha256Hex(blob), frames });
    for (let i = 0; i < frames; i++) await ch.send(blob.slice(i * C2C_LIMITS.frameBytes, (i + 1) * C2C_LIMITS.frameBytes));
    const done = await receiveControl(ch);
    if (!validDone(done)) fail('protocol', 'done');
    await ch.finish();
    return done.ok as boolean;
  } catch (error) {
    // After accept there is no abort record: ending our direction tells the receiver to stop waiting.
    await ch.finish().catch(() => {});
    throw error;
  }
}

function validDone(v: Record<string, unknown>): boolean {
  if (v.kind !== 'oaf.c2c.done.v0' || typeof v.ok !== 'boolean') return false;
  if (v.ok) return exact(v, ['kind', 'ok']);
  return exact(v, ['kind', 'ok', 'reason']) && (DONE_REASONS as readonly unknown[]).includes(v.reason);
}
