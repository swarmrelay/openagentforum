import { afterEach, describe, expect, it } from 'vitest';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { ForumRendezvous, rendezvousScope, STREAM_LIMITS } from '@openagentforum/peer-stream';
import {
  ADAPTER, C2C_LIMITS, C2CFailure, KV_FORMAT, cacheDataBytes, checkCacheHeader, requestCache, serveCache,
  sha256Hex, tokenBytes, type Hello, type KvSchema, type RecordChannel, type SharerPolicy,
} from '../src/index.js';

// The pilot pair: Qwen2.5-0.5B-Instruct sharer cache (24 layers, 2 KV heads, head_dim 64, bfloat16).
const schema: KvSchema = { layers: 24, kvHeads: 2, headDim: 64, dtype: 'bfloat16' };
// Revisions are synthetic fixture values, not real model commits.
const sharer = { model: 'Qwen/Qwen2.5-0.5B-Instruct', revision: '1'.repeat(40) };

/** Same byte layout as Python safetensors.save: u64 LE header length, space-padded JSON header, data. */
type Opts = { gap?: number; dtype?: string };
type Tensors = Record<string, { shape: number[]; bytes: number }>;
type Tweak = (meta: Record<string, string>, tensors: Tensors) => void;
function safetensors(tensors: Tensors, metadata: Record<string, string>, opts: Opts = {}) {
  const header: Record<string, unknown> = { __metadata__: metadata };
  let offset = 0;
  for (const [name, t] of Object.entries(tensors)) {
    header[name] = { dtype: opts.dtype ?? 'BF16', shape: t.shape, data_offsets: [offset, offset + t.bytes] };
    offset += t.bytes + (opts.gap ?? 0);
  }
  let json = JSON.stringify(header);
  json += ' '.repeat((8 - ((8 + json.length) % 8)) % 8);
  const out = new Uint8Array(8 + json.length + offset);
  new DataView(out.buffer).setBigUint64(0, BigInt(json.length), true);
  out.set(new TextEncoder().encode(json), 8);
  for (let i = 8 + json.length; i < out.length; i++) out[i] = i % 251;
  return out;
}
function cacheFor(ids: Uint32Array, tweak: Tweak = () => {}, opts: Opts = {}) {
  const meta: Record<string, string> = {
    format: KV_FORMAT, model: sharer.model, revision: sharer.revision, dtype: 'bfloat16', layers: '24', kv_heads: '2',
    head_dim: '64', tokens: String(ids.length), token_ids_sha256: sha256Hex(tokenBytes(ids)),
  };
  const tensors: Tensors = {};
  for (let i = 0; i < schema.layers; i++) for (const kv of ['k', 'v']) tensors[`${kv}.${i}`] = { shape: [1, 2, ids.length, 64], bytes: 2 * ids.length * 64 * 2 };
  tweak(meta, tensors);
  return safetensors(tensors, meta, opts);
}
const ids = (n: number) => Uint32Array.from({ length: n }, (_, i) => 150_000 + (i * 7919) % 1000);   // inside the vocabulary
function hello(tokenIds: Uint32Array, overrides: Partial<Hello> = {}): Hello {
  return {
    kind: 'oaf.c2c.hello.v0', adapter: ADAPTER,
    receiver: { model: 'Qwen/Qwen3-0.6B', revision: '2'.repeat(40) }, sharer,
    fuser: { model: 'nics-efc/C2C_Fuser', path: 'qwen3_0.6b+qwen2.5_0.5b_Fuser/final', manifestSha256: 'a'.repeat(64) },
    schema, limits: { maxTokens: 1024, maxBytes: C2C_LIMITS.maxBytes },
    tokenIds: { count: tokenIds.length, sha256: sha256Hex(tokenBytes(tokenIds)) }, ...overrides,
  };
}

/** In-memory bound channel pair with the same send/receive/finish shape as FramedStream. */
function channelPair(): [RecordChannel & { sent: Uint8Array[] }, RecordChannel & { sent: Uint8Array[] }] {
  const make = () => ({ queue: [] as (Uint8Array | null)[], waiters: [] as ((v: Uint8Array | null) => void)[] });
  const ab = make(), ba = make();
  const push = (q: ReturnType<typeof make>, v: Uint8Array | null) => { const w = q.waiters.shift(); if (w) w(v); else q.queue.push(v); };
  const end = (out: ReturnType<typeof make>, inbox: ReturnType<typeof make>) => {
    const sent: Uint8Array[] = [];
    return {
      sent,
      async send(bytes: Uint8Array) { if (bytes.byteLength > C2C_LIMITS.frameBytes) throw new Error('frame limit'); sent.push(bytes); push(out, bytes.slice()); },
      async receive() { return inbox.queue.length ? inbox.queue.shift()! : new Promise<Uint8Array | null>(resolve => inbox.waiters.push(resolve)); },
      async finish() { push(out, null); },
    };
  };
  return [end(ab, ba), end(ba, ab)];
}
const VOCAB = 151_936;   // Qwen2.5-0.5B embedding rows
const policy = (compute: SharerPolicy['compute'], decide: SharerPolicy['decide'] = () => null): SharerPolicy => ({ vocabSize: VOCAB, decide, compute });
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** A sharer that skips every self-check, to exercise the receiver's own validation. */
async function rawSharer(end: RecordChannel, blob: Uint8Array, lie: { sha256?: string; bytes?: number; frameBytes?: number; stopAfterFrames?: number; acceptExtra?: boolean } = {}) {
  const h = JSON.parse(new TextDecoder().decode((await end.receive())!));
  await end.send(json({ kind: 'oaf.c2c.accept.v0', adapter: ADAPTER, sharer: h.sharer, schema: h.schema, ...(lie.acceptExtra ? { extra: 1 } : {}) }));
  if (lie.acceptExtra) return null;
  await end.receive();
  const size = lie.frameBytes ?? C2C_LIMITS.frameBytes, bytes = lie.bytes ?? blob.byteLength;
  const frames = Math.ceil(blob.byteLength / size);
  await end.send(json({ kind: 'oaf.c2c.cache.v0', bytes, sha256: lie.sha256 ?? sha256Hex(blob), frames: Math.ceil(bytes / size) }));
  if (lie.bytes !== undefined) return JSON.parse(new TextDecoder().decode((await end.receive())!));
  for (let i = 0; i < Math.min(frames, lie.stopAfterFrames ?? frames); i++) await end.send(blob.slice(i * size, (i + 1) * size));
  if (lie.stopAfterFrames !== undefined) { await end.finish(); return null; }
  return JSON.parse(new TextDecoder().decode((await end.receive())!));
}

describe('C2C adapter negotiation and transfer', () => {
  it('moves a pilot-sized cache and returns exactly the bytes the sharer computed', async () => {
    const tokenIds = ids(85), blob = cacheFor(tokenIds);
    expect(blob.byteLength).toBeGreaterThan(cacheDataBytes(schema, 85));
    const [receiver, sharerEnd] = channelPair();
    const seen: Uint32Array[] = [];
    const [got, ok] = await Promise.all([
      requestCache(receiver, hello(tokenIds), tokenIds),
      serveCache(sharerEnd, policy(async t => { seen.push(t); return blob; })),
    ]);
    expect(got).toEqual(blob);
    expect(ok).toBe(true);
    expect(seen[0]).toEqual(tokenIds);
    expect(sharerEnd.sent.every(frame => frame.byteLength <= C2C_LIMITS.frameBytes)).toBe(true);
  });

  it('surfaces a fixed refusal and sends nothing after it', async () => {
    const tokenIds = ids(10);
    const [receiver, sharerEnd] = channelPair();
    const compute = async () => { throw new Error('must not compute'); };
    const [result, served] = await Promise.all([
      requestCache(receiver, hello(tokenIds), tokenIds).catch(e => e),
      serveCache(sharerEnd, policy(compute, () => 'unsupported-model')),
    ]);
    expect(result).toBeInstanceOf(C2CFailure);
    expect(result).toMatchObject({ code: 'refused', reason: 'unsupported-model' });
    expect(served).toBe(false);
    expect(receiver.sent).toHaveLength(1);
  });

  const malformed: [string, Tweak, Opts][] = [
    ['a wrong dtype', () => {}, { dtype: 'F32' }],
    ['a metadata model mismatch', m => { m.model = 'Qwen/Other-0.5B'; }, {}],
    ['a token digest mismatch', m => { m.token_ids_sha256 = 'b'.repeat(64); }, {}],
    ['an extra metadata key', m => { m.note = 'hi'; }, {}],
    ['a missing tensor', (_m, t) => { delete t['v.23']; }, {}],
    ['an extra tensor', (_m, t) => { t['x.0'] = { shape: [1, 2, 20, 64], bytes: 5120 }; }, {}],
    ['a wrong shape', (_m, t) => { t['k.3'] = { shape: [1, 2, 20, 32], bytes: 5120 }; }, {}],
    ['gaps between tensors', () => {}, { gap: 2 }],
  ];

  it.each(malformed)('the sharer refuses to send a cache with %s', async (_label, tweak, opts) => {
    const tokenIds = ids(20), blob = cacheFor(tokenIds, tweak, opts);
    expect(() => checkCacheHeader(blob, blob.byteLength, { schema, tokens: 20, sharer, tokenIdsSha256: sha256Hex(tokenBytes(tokenIds)) })).toThrow(C2CFailure);
    const [receiver, sharerEnd] = channelPair();
    const [result, served] = await Promise.all([
      requestCache(receiver, hello(tokenIds), tokenIds).catch(e => e),
      serveCache(sharerEnd, policy(async () => blob)).catch(e => e),
    ]);
    // The sharer checks its own output first and ends its direction, so no cache bytes leave it.
    expect(served).toMatchObject({ code: 'integrity' });
    expect(result).toMatchObject({ code: 'closed' });
    expect(sharerEnd.sent.map(f => f.byteLength).every(n => n < 1024)).toBe(true);
  });

  it.each(malformed)('the receiver rejects a dishonest sharer sending a cache with %s', async (_label, tweak, opts) => {
    const tokenIds = ids(20), blob = cacheFor(tokenIds, tweak, opts);
    const [receiver, sharerEnd] = channelPair();
    const lying = rawSharer(sharerEnd, blob);
    // A wrong-sized cache is already refused at the announcement; the rest fail header validation.
    const error = await requestCache(receiver, hello(tokenIds), tokenIds).catch(e => e);
    expect(error).toBeInstanceOf(C2CFailure);
    expect(['integrity', 'limit']).toContain(error.code);
    expect(await lying).toMatchObject({ kind: 'oaf.c2c.done.v0', ok: false });
  });

  it('rejects corrupted tensor bytes by digest even when the sharer lies about the hash', async () => {
    const tokenIds = ids(40), blob = cacheFor(tokenIds), corrupt = blob.slice();
    corrupt[corrupt.length - 1] ^= 0xff;
    const [receiver, sharerEnd] = channelPair();
    const lying = rawSharer(sharerEnd, corrupt, { sha256: sha256Hex(blob) });
    await expect(requestCache(receiver, hello(tokenIds), tokenIds)).rejects.toMatchObject({ code: 'integrity', reason: 'sha256' });
    expect(await lying).toEqual({ kind: 'oaf.c2c.done.v0', ok: false, reason: 'invalid-cache' });
  });

  it('refuses oversized announcements, unknown fields, wrong frame sizes and truncated transfers', async () => {
    const tokenIds = ids(20), blob = cacheFor(tokenIds);
    {
      const [receiver, sharerEnd] = channelPair();
      const lying = rawSharer(sharerEnd, blob, { bytes: 100_000_000 });
      await expect(requestCache(receiver, hello(tokenIds), tokenIds)).rejects.toMatchObject({ code: 'limit' });
      expect(await lying).toEqual({ kind: 'oaf.c2c.done.v0', ok: false, reason: 'limits' });
    }
    {
      const [receiver, sharerEnd] = channelPair();
      void rawSharer(sharerEnd, blob, { acceptExtra: true });
      await expect(requestCache(receiver, hello(tokenIds), tokenIds)).rejects.toMatchObject({ code: 'protocol', reason: 'accept' });
    }
    {
      const [receiver, sharerEnd] = channelPair();
      void rawSharer(sharerEnd, blob, { frameBytes: 8_192 });
      await expect(requestCache(receiver, hello(tokenIds), tokenIds)).rejects.toMatchObject({ code: 'limit', reason: 'cache header' });
    }
    {
      const [receiver, sharerEnd] = channelPair();
      void rawSharer(sharerEnd, blob, { stopAfterFrames: 1 });
      await expect(requestCache(receiver, hello(tokenIds), tokenIds)).rejects.toMatchObject({ code: 'closed' });
    }
    {
      const [receiver, sharerEnd] = channelPair();
      void (async () => { await sharerEnd.receive(); await sharerEnd.send(new Uint8Array(C2C_LIMITS.controlBytes + 1)); })();
      await expect(requestCache(receiver, hello(tokenIds), tokenIds)).rejects.toMatchObject({ code: 'limit', reason: 'control record' });
    }
    {
      const [receiver, sharerEnd] = channelPair();
      void (async () => { await sharerEnd.receive(); await sharerEnd.send(json({ kind: 'oaf.c2c.refuse.v0', reason: 'because I said so' })); })();
      await expect(requestCache(receiver, hello(tokenIds), tokenIds)).rejects.toMatchObject({ code: 'protocol', reason: 'refuse' });
    }
  });

  it('the sharer rejects token IDs outside its vocabulary before computing', async () => {
    const tokenIds = Uint32Array.from([151_643, 872, VOCAB]);   // a special token is fine; VOCAB itself is one past the table
    const [receiver, sharerEnd] = channelPair();
    const [result, served] = await Promise.all([
      requestCache(receiver, hello(tokenIds), tokenIds).catch(e => e),
      serveCache(sharerEnd, policy(async () => { throw new Error('must not compute'); })).catch(e => e),
    ]);
    expect(served).toMatchObject({ code: 'protocol', reason: 'token range' });
    expect(result).toMatchObject({ code: 'closed' });
    await expect(serveCache(channelPair()[1], { ...policy(async () => new Uint8Array()), vocabSize: 0 })).rejects.toMatchObject({ reason: 'vocabSize' });
  });

  it('the sharer rejects token IDs that do not match the hello', async () => {
    const tokenIds = ids(12);
    const [receiver, sharerEnd] = channelPair();
    const served = serveCache(sharerEnd, policy(async () => { throw new Error('must not compute'); })).catch(e => e);
    await receiver.send(json(hello(tokenIds)));
    expect(JSON.parse(new TextDecoder().decode((await receiver.receive())!))).toMatchObject({ kind: 'oaf.c2c.accept.v0' });
    await receiver.send(tokenBytes(ids(13).subarray(1)));
    expect(await served).toMatchObject({ code: 'protocol', reason: 'token ids' });
    expect(await receiver.receive()).toBeNull();
  });

  it('validates the hello strictly on both sides', async () => {
    const tokenIds = ids(5);
    const [receiver] = channelPair();
    await expect(requestCache(receiver, hello(tokenIds, { tokenIds: { count: 5, sha256: 'd'.repeat(64) } }), tokenIds)).rejects.toMatchObject({ code: 'protocol', reason: 'token ids' });
    await expect(requestCache(receiver, { ...hello(tokenIds), extra: true } as unknown as Hello, tokenIds)).rejects.toMatchObject({ code: 'protocol' });
    await expect(requestCache(receiver, hello(tokenIds, { sharer: { model: 'https://evil.example/x', revision: sharer.revision } }), tokenIds)).rejects.toMatchObject({ code: 'protocol' });
    await expect(requestCache(receiver, hello(tokenIds, { limits: { maxTokens: 1024, maxBytes: 64 << 20 } }), tokenIds)).rejects.toMatchObject({ code: 'protocol' });
    // A cache that cannot fit the negotiated budget is refused before anything is sent.
    const big = ids(1000);
    await expect(requestCache(receiver, hello(big, { limits: { maxTokens: 1024, maxBytes: 1_000_000 } }), big)).rejects.toMatchObject({ code: 'limit' });
    expect(receiver.sent).toHaveLength(0);
  });
});

describe('fits one peer-stream session', () => {
  it('keeps the largest exchange inside the per-direction frame and byte budgets', () => {
    const bind = { frames: 2, bytes: 2 * 512 };   // ForumRendezvous hello + confirm records, each at most 512 bytes
    expect(C2C_LIMITS.frameBytes).toBe(STREAM_LIMITS.frameBytes);
    expect(C2C_LIMITS.maxFrames).toBe(Math.ceil(C2C_LIMITS.maxBytes / C2C_LIMITS.frameBytes));
    // Sharer direction: bind, accept, cache header, cache frames.
    expect(bind.frames + 2 + C2C_LIMITS.maxFrames).toBeLessThanOrEqual(STREAM_LIMITS.framesPerDirection);
    expect(bind.bytes + 2 * C2C_LIMITS.controlBytes + C2C_LIMITS.maxBytes).toBeLessThanOrEqual(STREAM_LIMITS.bytesPerDirection);
    // Receiver direction: bind, hello, token IDs, done.
    expect(bind.bytes + 2 * C2C_LIMITS.controlBytes + 4 * C2C_LIMITS.maxTokens).toBeLessThanOrEqual(STREAM_LIMITS.bytesPerDirection);
    expect(4 * C2C_LIMITS.maxTokens).toBeLessThanOrEqual(STREAM_LIMITS.frameBytes);
  });

  it('refuses an announcement with more frames than one exchange allows', async () => {
    const tokenIds = ids(20), blob = cacheFor(tokenIds);
    const [receiver, sharerEnd] = channelPair();
    void rawSharer(sharerEnd, blob, { frameBytes: 1_000 });
    await expect(requestCache(receiver, hello(tokenIds), tokenIds)).rejects.toMatchObject({ code: 'limit', reason: 'cache header' });
  });
});

describe('over a real authenticated peer-stream session', () => {
  const sessions: ForumRendezvous[] = [];
  afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())); });

  it.each([
    ['a pilot-sized (~1 MB, 85-token)', 85],
    ['the largest allowed (~4.1 MB, 333-token)', 333],
  ])('carries %s cache through signed rendezvous, Noise and the session budget', async (_label, tokens) => {
    const [a, b] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
    const scope = rendezvousScope('http://127.0.0.1:9876', 'c2c-adapter-fixture');
    const receiverSide = new ForumRendezvous(a, b.signingPublicKey, scope), sharerSide = new ForumRendezvous(b, a.signingPublicKey, scope);
    sessions.push(receiverSide, sharerSide);
    const offer = await receiverSide.offer(0), acceptance = await sharerSide.accept(offer, 0);
    const [receiverStream, sharerStream] = await Promise.all([receiverSide.wait(acceptance), sharerSide.connect()]);
    const tokenIds = ids(tokens), blob = cacheFor(tokenIds);
    expect(blob.byteLength).toBeGreaterThan(cacheDataBytes(schema, tokens));
    expect(blob.byteLength).toBeLessThanOrEqual(C2C_LIMITS.maxBytes);
    const [got, ok] = await Promise.all([
      requestCache(receiverStream, hello(tokenIds), tokenIds),
      serveCache(sharerStream, policy(async () => blob)),
    ]);
    expect(got).toEqual(blob);
    expect(ok).toBe(true);
  }, 45_000);
});
