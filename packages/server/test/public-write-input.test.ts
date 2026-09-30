import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAgentKeyPair, signEnvelope, verifyEnvelope, signTaskAction } from '@openagentforum/protocol';
import { PUBLIC_WRITE_LIMITS as L, PublicWriteInputError, readPublicWriteInput, type PublicWriteKind } from '../src/public-write-input.js';
import { adapterFixture } from './adapter-fixture.js';
import { pagesWakeFixture } from './pages-wake-fixture.js';

const id = 'agent_0123456789abcdef';
const examples: [PublicWriteKind, string, object, number][] = [
  ['channel', '/v1/channels', { name: 'example', title: 'Example' }, L.channelBytes],
  ['message', '/v1/channels/example/messages', { id: 'message', channel: 'example', sender: id, type: 'intel',
    sequence: 0, timestamp: 1, payload: { text: 'value' }, checksum: 'a'.repeat(64), signature: 'b'.repeat(128) }, L.messageBytes],
  ['task-create', '/v1/tasks', { creatorId: id, title: 'Work', description: 'Public work' }, L.taskCreateBytes],
  ['task-claim', '/v1/tasks/task_example/claim', { agentId: id }, L.taskClaimBytes],
  ['task-submit', '/v1/tasks/task_example/submit', { agentId: id, resultPayload: { text: 'done' } }, L.taskSubmitBytes],
];
const request = (body: BodyInit | null, headers: Record<string, string> = {}, signal?: AbortSignal) => new Request('https://relay.test', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal, duplex: 'half',
} as RequestInit);
const read = (body: BodyInit | null, kind: PublicWriteKind = 'channel', headers: Record<string, string> = {}, signal?: AbortSignal) =>
  readPublicWriteInput(request(body, headers, signal), kind, kind === 'message' ? 'example' : 'task_example');
afterEach(() => { vi.useRealTimers(); });

describe('public input transport and structure bounds', () => {
  it.each(examples)('%s counts actual UTF-8 bytes at its boundary, regardless of Content-Length', async (kind, _path, body, bytes) => {
    const raw = JSON.stringify({ ...body, extension: '😀' });
    const exact = raw + ' '.repeat(bytes - Buffer.byteLength(raw));
    expect(await read(exact, kind)).toEqual({ ...body, extension: '😀' });
    await expect(read(exact + ' ', kind, { 'content-length': '1' })).rejects.toMatchObject({ status: 413 });
  });

  it.each([
    ['content-type', 'text/plain', 415], ['content-type', 'application/json; charset=latin1', 415],
    ['content-type', 'application/json; boundary=foo', 415], ['content-encoding', 'gzip', 415],
    ['content-length', '-1', 400], ['content-length', '1.5', 400], ['content-length', '1e6', 400],
    ['content-length', '999999999999999999999999', 413],
  ] as const)('rejects %s=%s without reading and cancels the producer', async (name, value, status) => {
    let pulls = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 });
    await expect(read(body, 'channel', { [name]: value })).rejects.toMatchObject({ status });
    expect(pulls).toBe(0); expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  });

  it('accepts split multibyte UTF-8 and JSON string escapes without interpreting string braces as nesting', async () => {
    const value = { name: 'unicode', title: '😀', topic: '\\"' + '[{'.repeat(50) };
    const bytes = new TextEncoder().encode(JSON.stringify(value)); let i = 0;
    const body = new ReadableStream({ pull(c) { if (i < bytes.length) c.enqueue(bytes.slice(i, ++i)); else c.close(); } });
    expect(await read(body, 'channel', { 'content-type': 'Application/JSON; charset="UTF-8"' })).toEqual(value);
  });

  it('rejects malformed input without returning its contents or decoding invalid UTF-8 with replacement characters', async () => {
    for (const raw of [null, 'null', '[]', '{"private":', '\ufeff{}', Uint8Array.of(0xff), Uint8Array.of(0xc3)]) {
      const error = await read(raw).catch(e => e);
      expect(error).toBeInstanceOf(PublicWriteInputError);
      expect(error.status).toBe(400);
      const response = error.getResponse();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'invalid_public_input', code: 'invalid_public_input' });
    }
  });

  it('bounds depth before parsing, and bounds collection width, total nodes and property lengths before canonicalization', async () => {
    const base = { name: 'structure', title: 'Structure' };
    const deep = (n: number) => '{"name":"structure","title":"Structure","extension":' + '['.repeat(n) + '0' + ']'.repeat(n) + '}';
    expect(await read(deep(L.depth - 1))).toMatchObject(base);
    await expect(read(deep(L.depth))).rejects.toMatchObject({ status: 413 });
    await expect(read(deep(10000))).rejects.toMatchObject({ status: 413 });
    expect(await read(JSON.stringify({ ...base, extension: Array(L.entries).fill(0) }))).toMatchObject(base);
    await expect(read(JSON.stringify({ ...base, extension: Array(L.entries + 1).fill(0) }))).rejects.toMatchObject({ status: 413 });
    await expect(read(JSON.stringify({ ...base, extension: { ['x'.repeat(L.propertyLength + 1)]: 0 } }))).rejects.toMatchObject({ status: 413 });
    const wide = Array.from({ length: 9 }, () => Array(1000).fill(0));
    await expect(read(JSON.stringify({ ...examples[1][2], payload: wide }), 'message')).rejects.toMatchObject({ status: 413 });
    await expect(read('{"name":"numbers","title":"Numbers","extension":1e999}')).rejects.toMatchObject({ status: 400 });
  });

  it('cancels endless empty chunks without waiting for an uncooperative cancellation promise', async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); }, cancel() { cancelled = true; return new Promise(() => {}); } });
    await expect(read(body)).rejects.toMatchObject({ status: 400 });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  });

  it('uses one deadline for the complete stream and handles abort without hanging', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
    const result = read(body).catch(e => e);
    await vi.advanceTimersByTimeAsync(L.readTimeoutMs);
    expect(await result).toMatchObject({ status: 408 });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
    const controller = new AbortController();
    const abortedBody = new ReadableStream();
    const aborted = read(abortedBody, 'channel', {}, controller.signal).catch(e => e);
    controller.abort();
    expect(await aborted).toMatchObject({ status: 400 });
    expect(abortedBody.locked).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(['Worker', 'standalone', 'Pages D1', 'Pages memory'] as const)('%s public write admission', adapter => {
  async function fixture() {
    if (adapter === 'Worker' || adapter === 'standalone') return adapterFixture(adapter);
    const f = await pagesWakeFixture();
    return { ...f, dispatch: (request: Request) => f.dispatch(request, {
      PUBLIC_ORIGIN: 'https://relay.test', ...(adapter === 'Pages D1' ? { DB: f.env.DB } : {}),
    }) };
  }
  it('rejects bad bodies on every mutation before any database access; anonymous reads still work', async () => {
    const f = await fixture();
    try {
      const prepare = vi.spyOn(f.db, 'prepare');
      for (const [_kind, path, _body, max] of examples) {
        for (const [raw, status] of [['{', 400], [' '.repeat(max + 1), 413]] as const) {
          prepare.mockClear();
          const response = await f.dispatch(new Request('https://relay.test' + path, request(raw)));
          expect(response.status).toBe(status);
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(prepare).not.toHaveBeenCalled();
          expect((await response.text()).length).toBeLessThan(150);
        }
      }
      prepare.mockRestore();
      expect((await f.dispatch(new Request('https://relay.test/v1/channels'))).status).toBe(200);
    } finally { f.close(); }
  });

  it('preserves signed message fields, replay and task lifecycle through the real adapter', async () => {
    const f = await fixture();
    const send = (path: string, value?: unknown) => f.dispatch(new Request('https://relay.test' + path,
      value === undefined ? undefined : request(JSON.stringify(value))));
    try {
      const keys = await generateAgentKeyPair(); const channel = 'input-' + crypto.randomUUID();
      expect((await send('/v1/agents/register', { publicKey: keys.signingPublicKey })).status).toBe(200);
      const envelope = await signEnvelope({ channel, sender: keys.agentId, type: 'intel', sequence: 71,
        payload: { text: ' é e\u0301 😀 ', escapedSurrogate: '\ud800', constructor: { prototype: 'data' } } }, keys.signingPrivateKey);
      const path = `/v1/channels/${channel}/messages`;
      expect((await send(path, envelope)).status).toBe(200);
      expect((await send(path, envelope)).status).toBe(200);
      const { messages } = await (await send(path)).json();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject(JSON.parse(JSON.stringify(envelope)));
      expect((await verifyEnvelope(messages[0], keys.signingPublicKey)).valid).toBe(true);
      // The input boundary cannot repair a mismatched destination or signed type.
      expect((await send(path, { ...envelope, channel: 'elsewhere' })).status).toBe(400);
      expect((await send(path, { ...envelope, sequence: '71' })).status).toBe(400);
      const task = { title: ' Input fixture ', description: 'A bounded local test', requiredCapabilities: [], timeoutMs: 60000, reward: null };
      const timestamp = Date.now();
      const signature = await signTaskAction({ action: 'create', taskId: '-', agentId: keys.agentId, timestamp, payload: task }, keys.signingPrivateKey);
      const created = await send('/v1/tasks', { ...task, creatorId: keys.agentId, signature, timestamp });
      expect(created.status).toBe(200); const { task: { id: taskId } } = await created.json();
      for (const action of ['claim', 'submit'] as const) {
        const payload = action === 'claim' ? {} : { resultPayload: { text: ' complete ' } };
        const proof = await signTaskAction({ action, taskId, agentId: keys.agentId, timestamp, payload }, keys.signingPrivateKey);
        expect((await send(`/v1/tasks/${taskId}/${action}`, { agentId: keys.agentId, ...payload, timestamp, signature: proof })).status).toBe(200);
      }
    } finally { f.close(); }
  });
});
