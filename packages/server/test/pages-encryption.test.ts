import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptFromPrivateChannel, decryptPayloadFromSender, encryptForPrivateChannel, encryptPayloadForRecipient, generatePrivateChannelKey, signEnvelope, verifyEnvelope } from '@openagentforum/protocol';
import { pagesWakeFixture } from './pages-wake-fixture.js';
import type { HubEnv } from '../../../apps/web/functions/_lib/wake.js';

const fixtures: Awaited<ReturnType<typeof pagesWakeFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function setup(backend: string) {
  const f = await pagesWakeFixture(); fixtures.push(f);
  const broadcastMessage = vi.fn(async (_message: unknown) => {});
  // Capture only the route's fan-out call; this is not a DO runtime test.
  const bindings: HubEnv = { ...(backend === 'D1' ? f.env : {}), SWARM_CHANNEL: {
    idFromName: vi.fn(), get: vi.fn(() => ({ broadcastMessage })),
  } as HubEnv['SWARM_CHANNEL'] };
  const send = (path: string, body?: unknown) => f.dispatch(new Request('https://relay.test' + path,
    body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), bindings);
  for (const agent of [f.owner, f.sender]) expect((await send('/v1/agents/register', { publicKey: agent.signingPublicKey })).status).toBe(200);
  const channel = 'private-' + crypto.randomUUID();
  expect((await send('/v1/channels', { name: channel, title: 'Local encrypted fixture', isPrivate: true, e2eeRequired: true })).status).toBe(200);
  const key = generatePrivateChannelKey();
  const encrypted = await encryptForPrivateChannel({ message: 'local encrypted fixture' }, key);
  const envelope = await signEnvelope({ channel, sender: f.owner.agentId, type: 'e2ee_blob', sequence: 7,
    payload: { ciphertext: encrypted.ciphertext }, encrypted: true, nonce: encrypted.nonce }, f.owner.signingPrivateKey);
  return { ...f, send, broadcastMessage, channel, key, envelope, path: `/v1/channels/${channel}/messages` };
}

describe.each(['D1', 'memory'])('Pages encrypted records (%s)', backend => {
  it('rejects plaintext and malformed encryption before auto-creating a DM (#180)', async () => {
    const f = await setup(backend);
    const channel = 'dm-new-' + crypto.randomUUID();
    const path = `/v1/channels/${channel}/messages`;
    const plaintext = await signEnvelope({ channel, sender: f.owner.agentId, type: 'intel', payload: 'must not store' }, f.owner.signingPrivateKey);
    const denied = await f.send(path, plaintext);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason: 'encryption_required' });
    const malformed = await signEnvelope({ channel, sender: f.owner.agentId, type: 'e2ee_blob', encrypted: true,
      payload: f.envelope.payload }, f.owner.signingPrivateKey);
    expect((await f.send(path, malformed)).status).toBe(400);
    expect((await f.send(`/v1/channels/${channel}`)).status).toBe(404);
    expect((await (await f.send(path)).json()).messages).toEqual([]);
    expect(f.broadcastMessage).not.toHaveBeenCalled();
  });

  it('keeps auto-created DMs encryption-required after the first encrypted message (#180)', async () => {
    const f = await setup(backend);
    const channel = 'dm-sticky-' + crypto.randomUUID();
    const path = `/v1/channels/${channel}/messages`;
    const encrypted = await signEnvelope({ channel, sender: f.owner.agentId, type: 'e2ee_blob', encrypted: true,
      payload: f.envelope.payload, nonce: f.envelope.nonce }, f.owner.signingPrivateKey);
    expect((await f.send(path, encrypted)).status).toBe(200);
    expect((await (await f.send(`/v1/channels/${channel}`)).json()).channel)
      .toMatchObject({ isPrivate: true, e2eeRequired: true, messageCount: 1 });
    const plaintext = await signEnvelope({ channel, sender: f.sender.agentId, type: 'intel', payload: 'must not store' }, f.sender.signingPrivateKey);
    expect((await f.send(path, plaintext)).status).toBe(403);
    expect((await f.send('/v1/channels', { name: channel, title: 'Overwrite', isPrivate: false, e2eeRequired: false })).status).toBe(409);
    expect((await (await f.send(path)).json()).messages).toHaveLength(1);
    expect(f.broadcastMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary auto-created channels public and does not relabel existing public DM history', async () => {
    const f = await setup(backend);
    for (const prefix of ['public-new-', 'dm-legacy-']) {
      const channel = prefix + crypto.randomUUID();
      if (prefix === 'dm-legacy-') {
        expect((await f.send('/v1/channels', { name: channel, title: 'Existing public channel' })).status).toBe(200);
      }
      const envelope = await signEnvelope({ channel, sender: f.owner.agentId, type: 'intel', payload: 'public fixture' }, f.owner.signingPrivateKey);
      expect((await f.send(`/v1/channels/${channel}/messages`, envelope)).status).toBe(200);
      expect((await (await f.send(`/v1/channels/${channel}`)).json()).channel)
        .toMatchObject({ isPrivate: false, e2eeRequired: false, messageCount: 1 });
      expect((await (await f.send(`/v1/channels/${channel}/messages`)).json()).messages[0].payload).toBe('public fixture');
    }
  });

  it('ACKs and broadcasts only the stored record, excluding request extras (#180)', async () => {
    const f = await setup(backend);
    const response = await f.send(f.path, { ...f.envelope, storedSeq: 999, extraRequestField: 'not stored' });
    expect(response.status).toBe(200);
    const { envelope: acknowledged } = await response.json();
    const { messages: [saved] } = await (await f.send(f.path)).json();
    expect(acknowledged).toEqual(saved);
    expect(saved.extraRequestField).toBeUndefined();
    expect(saved.storedSeq).toBe(1);
    expect(saved.sequence).toBe(7);
    expect((await verifyEnvelope(saved, f.owner.signingPublicKey)).valid).toBe(true);
    expect(await decryptFromPrivateChannel(saved.payload.ciphertext, saved.nonce, f.key)).toEqual({ message: 'local encrypted fixture' });
    expect(f.broadcastMessage.mock.calls).toEqual([[saved]]);
    expect(await (await f.send(f.path, { ...f.envelope, extraRequestField: 'changed', storedSeq: 2000 })).json())
      .toEqual({ success: true, alreadyStored: true, envelope: saved });
    expect(f.broadcastMessage).toHaveBeenCalledTimes(1);
  });

  it('decrypts the fetched vault record, preserves its signature, and rejects a wrong key', async () => {
    const f = await setup(backend);
    expect((await f.send(f.path, f.envelope)).status).toBe(200);
    const { messages: [saved] } = await (await f.send(f.path + '?after=0')).json();
    expect(saved).toMatchObject(JSON.parse(JSON.stringify(f.envelope)));
    expect(saved.sequence).toBe(7); expect(saved.storedSeq).toBe(1);
    expect((await verifyEnvelope(saved, f.owner.signingPublicKey)).valid).toBe(true);
    expect(await decryptFromPrivateChannel(saved.payload.ciphertext, saved.nonce, f.key)).toEqual({ message: 'local encrypted fixture' });
    await expect(decryptFromPrivateChannel(saved.payload.ciphertext, saved.nonce, generatePrivateChannelKey())).rejects.toThrow();
  });

  it('preserves DM key, nonce, reply and recipient metadata on storage reads', async () => {
    const f = await setup(backend);
    const { ciphertext, nonce } = await encryptPayloadForRecipient({ message: 'local DM fixture' }, f.sender.encryptionPublicKey, f.owner.encryptionPrivateKey);
    const envelope = await signEnvelope({ channel: f.channel, sender: f.owner.agentId, type: 'e2ee_blob', payload: { ciphertext }, encrypted: true,
      nonce, ephemeralPublicKey: f.owner.encryptionPublicKey, replyToId: 'unsigned-parent', recipientKeys: {} }, f.owner.signingPrivateKey);
    expect((await f.send(f.path, envelope)).status).toBe(200);
    const { messages: [saved] } = await (await f.send(f.path)).json();
    expect(saved).toMatchObject(JSON.parse(JSON.stringify(envelope)));
    expect(await decryptPayloadFromSender(saved.payload.ciphertext, saved.nonce, saved.ephemeralPublicKey, f.sender.encryptionPrivateKey)).toEqual({ message: 'local DM fixture' });
  });

  it('acknowledges a matching replay once and rejects changed unsigned metadata', async () => {
    const f = await setup(backend);
    expect((await f.send(f.path, f.envelope)).status).toBe(200);
    const duplicate = await f.send(f.path, f.envelope);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ alreadyStored: true, envelope: { nonce: f.envelope.nonce, storedSeq: 1 } });
    const changedNonce = (await encryptForPrivateChannel({}, f.key)).nonce;
    expect((await f.send(f.path, { ...f.envelope, nonce: changedNonce })).status).toBe(409);
    expect((await (await f.send(f.path)).json()).messages).toHaveLength(1);
  });

  it('rejects plaintext and malformed encryption without storing either', async () => {
    const f = await setup(backend);
    const plaintext = await signEnvelope({ channel: f.channel, sender: f.sender.agentId, type: 'intel', payload: { message: 'must not store' } }, f.sender.signingPrivateKey);
    const rejected = await f.send(f.path, plaintext);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ reason: 'encryption_required' });
    for (const nonce of [undefined, '', 'not-a-nonce', 123]) {
      expect((await f.send(f.path, { ...f.envelope, nonce })).status).toBe(400);
    }
    const sideField = await signEnvelope({ channel: f.channel, sender: f.owner.agentId, type: 'e2ee_blob', encrypted: true, nonce: f.envelope.nonce,
      payload: { ciphertext: f.envelope.payload.ciphertext, message: 'plaintext side field' } }, f.owner.signingPrivateKey);
    expect((await f.send(f.path, sideField)).status).toBe(400);
    expect((await (await f.send(f.path)).json()).messages).toEqual([]);
  });

  it('does not claim membership support or overwrite private channel protection', async () => {
    const f = await setup(backend);
    const membership = await f.send('/v1/channels', { name: 'membership-' + crypto.randomUUID(), title: 'Unsupported', isPrivate: true, allowedAgents: [f.owner.agentId] });
    expect(membership.status).toBe(501);
    expect(await membership.json()).toMatchObject({ reason: 'membership_management_unavailable' });
    expect((await f.send('/v1/channels', { name: f.channel, title: 'Overwrite', isPrivate: false, e2eeRequired: false })).status).toBe(409);
    expect((await (await f.send(`/v1/channels/${f.channel}`)).json()).channel).toMatchObject({ isPrivate: true, e2eeRequired: true, title: 'Local encrypted fixture' });
  });
});

it('D1 duplicate acknowledgment reflects stored metadata; a changed nonce cannot masquerade as stored', async () => {
  const f = await setup('D1');
  expect((await f.send(f.path, f.envelope)).status).toBe(200);
  const duplicate = await f.send(f.path, f.envelope);
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ alreadyStored: true, envelope: { nonce: f.envelope.nonce } });
  const changedNonce = (await encryptForPrivateChannel({}, f.key)).nonce;
  expect((await f.send(f.path, { ...f.envelope, nonce: changedNonce })).status).toBe(409);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(1);
  // Old incomplete rows are not silently repaired by echoing a new request.
  f.db.prepare('UPDATE messages SET nonce = NULL').run();
  expect((await f.send(f.path, f.envelope)).status).toBe(409);
  expect((await (await f.send(f.path)).json()).messages[0].nonce).toBeUndefined();
});

it('SSE carries the same encryption metadata as the stored REST record', async () => {
  const f = await setup('D1');
  await f.send(f.path, f.envelope);
  const response = await f.send(`/v1/channels/${f.channel}/stream?after=0`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('event: envelope')) {
      const part = await reader.read();
      if (part.done) throw new Error('stream ended without its record');
      text += decoder.decode(part.value);
    }
    const saved = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6));
    expect(saved.nonce).toBe(f.envelope.nonce);
    expect(await decryptFromPrivateChannel(saved.payload.ciphertext, saved.nonce, f.key)).toEqual({ message: 'local encrypted fixture' });
  } finally { await reader.cancel(); }
});

it('rechecks encryption policy atomically if a protected channel appears during an ingest', async () => {
  const f = await setup('D1');
  const channel = 'race-' + crypto.randomUUID();
  const plaintext = await signEnvelope({ channel, sender: f.owner.agentId, type: 'intel', payload: { message: 'must not enter the new private channel' } }, f.owner.signingPrivateKey);
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  const spy = vi.spyOn(f.env.DB, 'prepare').mockImplementation(sql => {
    if (sql.includes('INSERT OR IGNORE INTO channels')) {
      f.db.prepare('INSERT INTO channels (name, title, topic, is_private, e2ee_required, creator_id, created_at) VALUES (?, ?, ?, 1, 1, ?, ?)')
        .run(channel, 'Protected', '', f.sender.agentId, Date.now());
    }
    return prepare(sql);
  });
  try {
    expect((await f.send(`/v1/channels/${channel}/messages`, plaintext)).status).toBe(403);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel = ?').get(channel)?.n).toBe(0);
  } finally { spy.mockRestore(); }
});
