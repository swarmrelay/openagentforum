import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { bytesToHex, generateAgentKeyPair, getEnvelopeSignString, hexToBytes, importEdPrivateKey, importEdPublicKey,
  sha256Hex, verifyEnvelope, type AgentKeyPair, type MessageEnvelope } from '@openagentforum/protocol';
import { adapterFixture } from './adapter-fixture.js';
import { pagesWakeFixture } from './pages-wake-fixture.js';

const fixture = JSON.parse(readFileSync(new URL('../../../apps/web/public/canonical-json-v1.json', import.meta.url), 'utf8')) as {
  vectors: { name: string; payloadJson: string; canonical: string; sha256: string }[];
};
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
type Adapter = 'Worker' | 'standalone' | 'Pages D1' | 'Pages memory';
async function setup(adapter: Adapter) {
  const key = await generateAgentKeyPair();
  const f = adapter === 'Worker' || adapter === 'standalone' ? adapterFixture(adapter) : await (async () => {
    const pages = await pagesWakeFixture();
    return { db: pages.db, close: pages.close, request: (path: string, body?: unknown) => pages.dispatch(new Request('https://relay.test' + path,
      body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    adapter === 'Pages D1' ? { DB: pages.env.DB } : {}) };
  })();
  cleanups.push(f.close);
  expect((await f.request('/v1/agents/register', { publicKey: key.signingPublicKey })).status).toBe(200);
  // Unique channel isolates the Pages memory fixture from other tests.
  const channel = 'canon-' + crypto.randomUUID();
  return { ...f, key, channel, path: `/v1/channels/${channel}/messages` };
}

/** Sign the supplied checksum directly, not via the canonicalizer under test. */
async function signed(key: AgentKeyPair, channel: string, payload: unknown, checksum: string, sequence = 0) {
  const envelope: MessageEnvelope<unknown> = { id: crypto.randomUUID(), channel, sender: key.agentId,
    type: 'intel', sequence, timestamp: Date.now(), payload, checksum, signature: '' };
  envelope.signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', await importEdPrivateKey(key.signingPrivateKey),
    new TextEncoder().encode(getEnvelopeSignString(envelope)))));
  return envelope;
}

describe.each(['Worker', 'standalone', 'Pages D1', 'Pages memory'] as const)('%s pinned canonical JSON admission (#153)', adapter => {
  it('accepts every fixed vector and preserves verifiable signed fields on fetch', async () => {
    const f = await setup(adapter);
    for (const [sequence, vector] of fixture.vectors.entries()) {
      const envelope = await signed(f.key, f.channel, JSON.parse(vector.payloadJson), vector.sha256, sequence);
      const r = await f.request(f.path, envelope);
      expect(r.status, vector.name).toBe(200);
    }
    const { messages } = await (await f.request(f.path + '?after=0')).json();
    expect(messages).toHaveLength(fixture.vectors.length);
    for (const [sequence, saved] of messages.entries()) {
      expect(saved.checksum).toBe(fixture.vectors[sequence].sha256);
      expect(saved.sequence).toBe(sequence);
      expect((await verifyEnvelope(saved, f.key.signingPublicKey)).valid).toBe(true);
    }
  });

  it('rejects divergent checksums despite valid signatures, before storing or acknowledging', async () => {
    const f = await setup(adapter);
    const variants = [
      { payload: { message: 'café' }, bytes: '{"message":"caf\\u00e9"}' },
      { payload: { z: 1, a: 2 }, bytes: '{"z":1,"a":2}' },
      { payload: { a: 2 }, bytes: '{ "a": 2 }' },
      { payload: { text: 'e\u0301' }, bytes: '{"text":"é"}' },
      { payload: { value: 1 }, bytes: '{"value":1.0}' },
      { payload: { '2': 'two', '10': 'ten' }, bytes: '{"2":"two","10":"ten"}' },
      { payload: { '😀': 1, '\ue000': 2 }, bytes: '{"\ue000":2,"😀":1}' },
    ];
    for (const variant of variants) {
      const envelope = await signed(f.key, f.channel, variant.payload, await sha256Hex(variant.bytes));
      // This must be a checksum failure, not a forged/invalid signature.
      expect(await crypto.subtle.verify('Ed25519', await importEdPublicKey(f.key.signingPublicKey),
        hexToBytes(envelope.signature), new TextEncoder().encode(getEnvelopeSignString(envelope)))).toBe(true);
      expect((await verifyEnvelope(envelope, f.key.signingPublicKey)).valid).toBe(false);
      const response = await f.request(f.path, envelope);
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty('alreadyStored');
    }
    expect((await (await f.request(f.path)).json()).messages).toEqual([]);
    if (adapter !== 'Pages memory') expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel = ?').get(f.channel)?.n).toBe(0);
  });

  if (adapter !== 'Pages memory') it('flags legacy divergent rows without rewriting history or accepting replay', async () => {
    const f = await setup(adapter);
    expect((await f.request('/v1/channels', { name: f.channel, title: 'Historical local fixture' })).status).toBe(200);
    const envelope = await signed(f.key, f.channel, { message: 'café' }, await sha256Hex('{"message":"caf\\u00e9"}'));
    f.db.prepare('INSERT INTO messages (id, channel, sender, type, sequence, stored_seq, timestamp, payload_json, signature, checksum) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
      .run(envelope.id, f.channel, envelope.sender, envelope.type, envelope.sequence, envelope.timestamp,
        JSON.stringify(envelope.payload), envelope.signature, envelope.checksum);
    const before = f.db.prepare('SELECT * FROM messages WHERE id = ?').get(envelope.id);
    const { messages: [saved] } = await (await f.request(f.path)).json();
    expect(saved).toMatchObject(envelope);
    expect((await verifyEnvelope(saved, f.key.signingPublicKey)).valid).toBe(false);
    expect((await f.request(f.path, saved)).status).toBe(403);
    expect(f.db.prepare('SELECT * FROM messages WHERE id = ?').get(envelope.id)).toEqual(before);
  });
});
