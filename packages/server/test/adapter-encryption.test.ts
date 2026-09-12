import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptFromPrivateChannel, encryptForPrivateChannel, generateAgentKeyPair, generatePrivateChannelKey, signEnvelope, verifyEnvelope } from '@openagentforum/protocol';
import { adapterFixture } from './adapter-fixture.js';

const fixtures: ReturnType<typeof adapterFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });

async function setup(adapter: 'Worker' | 'standalone') {
  const f = adapterFixture(adapter); fixtures.push(f);
  const owner = await generateAgentKeyPair();
  const outsider = await generateAgentKeyPair();
  for (const agent of [owner, outsider]) {
    expect((await f.request('/v1/agents/register', { publicKey: agent.signingPublicKey })).status).toBe(200);
  }
  const channel = 'local-vault';
  expect((await f.request('/v1/channels', { name: channel, title: 'Local fixture', isPrivate: true, e2eeRequired: true })).status).toBe(200);
  const key = generatePrivateChannelKey();
  const { ciphertext, nonce } = await encryptForPrivateChannel({ message: 'local fixture' }, key);
  const envelope = await signEnvelope({ channel, sender: owner.agentId, type: 'e2ee_blob', sequence: 7,
    payload: { ciphertext }, encrypted: true, nonce, ephemeralPublicKey: owner.encryptionPublicKey,
    recipientKeys: { [owner.agentId]: 'wrapped-local-key', [outsider.agentId]: 'wrapped-other-key' }, replyToId: '' }, owner.signingPrivateKey);
  return { ...f, owner, outsider, channel, key, envelope, path: `/v1/channels/${channel}/messages` };
}

describe.each(['Worker', 'standalone'] as const)('%s encryption admission and replay integrity (#175)', adapter => {
  it('returns the stored, decryptable record and rejects all changed unsigned metadata on replay', async () => {
    const f = await setup(adapter);
    const inserted = await f.request(f.path, { ...f.envelope, storedSeq: 999, extraRequestField: 'not stored' });
    expect(inserted.status).toBe(200);
    const { envelope: acknowledged } = await inserted.json();
    const { messages: [saved] } = await (await f.request(f.path)).json();
    expect(acknowledged).toEqual(saved);
    expect(saved.storedSeq).toBe(1);
    expect(saved.sequence).toBe(7);
    expect(saved.replyToId).toBe('');
    expect(saved.extraRequestField).toBeUndefined();
    expect((await verifyEnvelope(saved, f.owner.signingPublicKey)).valid).toBe(true);
    expect(await decryptFromPrivateChannel(saved.payload.ciphertext, saved.nonce, f.key)).toEqual({ message: 'local fixture' });
    const duplicate = await f.request(f.path, { ...f.envelope, storedSeq: 2000, recipientKeys: {
      [f.outsider.agentId]: 'wrapped-other-key', [f.owner.agentId]: 'wrapped-local-key',
    } });
    expect(await duplicate.json()).toEqual({ success: true, alreadyStored: true, envelope: saved });
    for (const patch of [
      { nonce: '00'.repeat(12) }, { ephemeralPublicKey: f.outsider.encryptionPublicKey },
      { recipientKeys: {} }, { replyToId: 'changed' },
    ]) expect((await f.request(f.path, { ...f.envelope, ...patch })).status).toBe(409);
    expect((await f.request(f.path, { ...f.envelope, encrypted: false })).status).toBe(403);
    expect(f.db.prepare('SELECT message_count FROM channels WHERE name = ?').get(f.channel)?.message_count).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(1);
    if (adapter === 'Worker') expect(f.broadcasts).toEqual([saved]);

    // Never repair a legacy row by acknowledging metadata it does not contain.
    f.db.prepare('UPDATE messages SET nonce = NULL WHERE id = ?').run(f.envelope.id);
    expect((await f.request(f.path, f.envelope)).status).toBe(409);
    expect(f.db.prepare('SELECT nonce FROM messages WHERE id = ?').get(f.envelope.id)?.nonce).toBeNull();
  });

  it('rejects outsider plaintext for either privacy flag and malformed encrypted records everywhere', async () => {
    const f = await setup(adapter);
    for (const policy of [{ isPrivate: true }, { e2eeRequired: true }]) {
      const channel = 'policy-' + crypto.randomUUID();
      expect((await f.request('/v1/channels', { name: channel, title: 'Policy', ...policy })).status).toBe(200);
      const plaintext = await signEnvelope({ channel, sender: f.outsider.agentId, type: 'intel', payload: { message: 'must not store' } }, f.outsider.signingPrivateKey);
      const denied = await f.request(`/v1/channels/${channel}/messages`, plaintext);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ reason: 'encryption_required' });
    }
    expect((await f.request(f.path, { ...f.envelope, encrypted: 'true' })).status).toBe(403);
    for (const patch of [{ nonce: undefined }, { nonce: 'bad' }, { nonce: 12 },
      { ephemeralPublicKey: 'bad' }, { recipientKeys: [] }, { recipientKeys: { bad: 'value' } }, { replyToId: 12 }]) {
      expect((await f.request(f.path, { ...f.envelope, ...patch })).status).toBe(400);
    }
    for (const channel of ['general', f.channel]) {
      const sideField = await signEnvelope({ channel, sender: f.owner.agentId, type: 'e2ee_blob', encrypted: true,
        nonce: f.envelope.nonce, payload: { ciphertext: f.envelope.payload.ciphertext, message: 'plaintext side field' } }, f.owner.signingPrivateKey);
      expect((await f.request(`/v1/channels/${channel}/messages`, sideField)).status).toBe(400);
    }
    for (const channel of ['dm-new-room', 'e2ee-new-room']) {
      const plaintext = await signEnvelope({ channel, sender: f.owner.agentId,
        type: channel.startsWith('dm-') ? 'intel' : 'e2ee_blob', payload: 'must not store' }, f.owner.signingPrivateKey);
      expect((await f.request(`/v1/channels/${channel}/messages`, plaintext)).status).toBe(403);
      expect(f.db.prepare('SELECT name FROM channels WHERE name = ?').get(channel)).toBeUndefined();
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(0);
    expect(f.broadcasts).toEqual([]);
  });

  it('refuses unsigned membership and channel overwrites without changing stored policy', async () => {
    const f = await setup(adapter);
    for (const allowedAgents of [[f.owner.agentId], 'not-a-list', null]) {
      const r = await f.request('/v1/channels', { name: 'unsupported', title: 'Unsupported', allowedAgents });
      expect(r.status).toBe(501);
      expect(await r.json()).toMatchObject({ reason: 'membership_management_unavailable' });
    }
    expect(f.db.prepare('SELECT * FROM channels WHERE name = ?').get('unsupported')).toBeUndefined();
    expect((await f.request('/v1/channels', { name: 'bad-flags', title: 'Invalid', isPrivate: 'false' })).status).toBe(400);
    for (const name of [f.channel, 'general']) {
      for (const isPrivate of [true, false]) {
        const response = await f.request('/v1/channels', { name, title: 'Overwrite', isPrivate });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ reason: 'channel_exists' });
      }
    }
    expect(f.db.prepare('SELECT is_private, e2ee_required, title, allowed_agents_json FROM channels WHERE name = ?').get(f.channel))
      .toMatchObject({ is_private: 1, e2ee_required: 1, title: 'Local fixture', allowed_agents_json: '[]' });
    f.db.prepare('UPDATE channels SET allowed_agents_json = ? WHERE name = ?').run(JSON.stringify([f.owner.agentId]), f.channel);
    const { channels } = await (await f.request('/v1/channels')).json();
    expect(channels.find((ch: { name: string }) => ch.name === f.channel).allowedAgents).toEqual([]);
  });

  it('rechecks policy in the insert if a protected channel appears after the initial read', async () => {
    const f = await setup(adapter);
    const channel = 'concurrent-room';
    const plaintext = await signEnvelope({ channel, sender: f.outsider.agentId, type: 'intel', payload: 'must not store' }, f.outsider.signingPrivateKey);
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (sql.includes('INSERT OR IGNORE INTO channels')) {
        prepare('INSERT INTO channels (name, title, topic, is_private, e2ee_required, creator_id, created_at) VALUES (?, ?, ?, 1, 1, ?, ?)')
          .run(channel, 'Protected', '', f.owner.agentId, Date.now());
      }
      return prepare(sql);
    });
    expect((await f.request(`/v1/channels/${channel}/messages`, plaintext)).status).toBe(403);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel = ?').get(channel)?.n).toBe(0);
    expect(f.db.prepare('SELECT message_count FROM channels WHERE name = ?').get(channel)?.message_count).toBe(0);
    expect(f.broadcasts).toEqual([]);
  });
});
