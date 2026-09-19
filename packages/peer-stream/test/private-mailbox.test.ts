import { afterEach, expect, it, vi } from 'vitest';
import { encryptPayloadForRecipient, generateAgentKeyPair, signEnvelope, verifyEnvelope } from '@openagentforum/protocol';
import { PrivateForumMailbox } from '../src/private-mailbox.js';
import { ForumMailbox } from '../src/forum-mailbox.js';
import { ForumRendezvous, peerIdFor, PUBLIC_FORUM_ORIGIN, rendezvousScope } from '../src/rendezvous.js';
import { LocalPeerStream, STREAM_PROTOCOL } from '../src/index.js';
import type { DirectPolicy } from '../src/direct-policy.js';

const scope = rendezvousScope('http://127.0.0.1:9876', 'private-fixture');
const mailboxes: PrivateForumMailbox[] = [];
afterEach(() => { mailboxes.splice(0).forEach(mailbox => mailbox.close()); vi.restoreAllMocks(); vi.useRealTimers(); });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
async function pair(publicHub = false, receiverIp = '1.1.1.1') {
  const [a, b] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
  const where = publicHub ? { ...scope, hub: PUBLIC_FORUM_ORIGIN } : scope;
  const records: any[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
    expect(String(url).startsWith(where.hub + '/v1/')).toBe(true);
    if (options?.method === 'POST') {
      const record = JSON.parse(options.body as string);
      expect((await verifyEnvelope(record, record.sender === a.agentId ? a.signingPublicKey : b.signingPublicKey)).valid).toBe(true);
      if (record.type === 'e2ee_blob') {
        expect(Object.keys(record.payload)).toEqual(['ciphertext']);
        expect(record.encrypted).toBe(true);
        expect(record.nonce).toBe(record.payload.ciphertext.slice(8, 32));
      }
      records.push(record); return json({ success: true, envelope: record });
    }
    if (String(url).includes('/agents/')) return json({ agent: { publicKey: b.signingPublicKey, x25519PublicKey: 'untrusted-directory-key' } });
    return json({ messages: records });
  });
  const listener: DirectPolicy = { role: 'listen', localIp: '1.1.1.1', peerIp: '1.0.0.1', port: 49123 };
  const dialer: DirectPolicy = { role: 'dial', peerIp: receiverIp, port: 49123 };
  const alice = await PrivateForumMailbox.create(a, b.signingPublicKey, where, publicHub ? listener : undefined, fetcher);
  const bob = await PrivateForumMailbox.create(b, a.signingPublicKey, where, publicHub ? dialer : undefined, fetcher);
  mailboxes.push(alice, bob);
  const keys = async () => {
    const ka = await alice.prepareKey(0), kb = await bob.prepareKey(0);
    await Promise.all([alice.post(ka), bob.post(kb)]);
    expect(await alice.findPeerKey()).toBe(true); expect(await bob.findPeerKey()).toBe(true);
    return { ka, kb };
  };
  const offer = async (changes: Record<string, unknown> = {}) => JSON.stringify(await signEnvelope({
    channel: where.channel, sender: a.agentId, type: 'intel', sequence: 1,
    payload: { kind: 'oaf.stream.offer.v1', hub: where.hub, sessionId: 'a'.repeat(64), from: a.signingPublicKey,
      to: b.signingPublicKey, expiresAt: Date.now() + 30_000, protocol: STREAM_PROTOCOL,
      address: `/ip4/${publicHub ? '1.1.1.1' : '127.0.0.1'}/tcp/49123/p2p/${peerIdFor(a.signingPublicKey)}`, ...changes },
  }, a.signingPrivateKey));
  return { a, b, alice, bob, records, fetcher, keys, offer, where };
}
async function resign(record: any, privateKey: string, changes: Record<string, unknown>) {
  return signEnvelope({ ...record, ...changes }, privateKey);
}

it('creates no traffic or listener; public discovery returns a candidate signing key, never an unsigned encryption key', async () => {
  const { b, fetcher, where } = await pair(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await PrivateForumMailbox.discover(where, b.agentId, fetcher)).toBe(b.signingPublicKey);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${PUBLIC_FORUM_ORIGIN}/v1/agents/${b.agentId}`,
    expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' }));
});

it('exchanges encrypted offers and acceptances with the existing ciphertext-only envelope schema', async () => {
  const { a, b, alice, bob, records, keys, offer, where } = await pair();
  await keys(); const raw = await offer();
  await alice.post(await alice.prepare(raw, 'offer', 1));
  expect(await bob.find('offer')).toBe(raw);
  const inner = JSON.parse(raw);
  const reply = JSON.stringify(await signEnvelope({ channel: where.channel, sender: b.agentId, type: 'intel', sequence: 1,
    payload: { kind: 'oaf.stream.accept.v1', hub: where.hub, sessionId: inner.payload.sessionId, from: b.signingPublicKey, to: a.signingPublicKey,
      expiresAt: inner.payload.expiresAt, protocol: STREAM_PROTOCOL, offerId: inner.id, offerHash: inner.checksum } }, b.signingPrivateKey));
  await bob.post(await bob.prepare(reply, 'accept', 1));
  expect(await alice.find('accept')).toBe(reply);
  expect(records).toHaveLength(4);
  expect(JSON.stringify(records)).not.toContain('/ip4/');
  expect(JSON.stringify(records)).not.toContain(inner.payload.sessionId);
  expect(JSON.stringify(records)).not.toContain('oaf.stream.offer.v1');
});

it('requires separately supplied public endpoint policy; reading an encrypted offer never creates or dials a node', async () => {
  const create = vi.spyOn(LocalPeerStream, 'createDirect');
  const { a, b, alice, bob, keys, offer, where, fetcher } = await pair(true);
  await expect(PrivateForumMailbox.create(a, b.signingPublicKey, where, undefined, fetcher)).rejects.toMatchObject({ code: 'invalid_input' });
  expect(() => new ForumRendezvous(a, b.signingPublicKey, where)).toThrow();
  expect(() => new ForumMailbox(PUBLIC_FORUM_ORIGIN, where.channel, fetcher)).toThrow();
  await keys(); const raw = await offer();
  await alice.post(await alice.prepare(raw, 'offer', 1));
  expect(await bob.find('offer')).toBe(raw);
  expect(create).not.toHaveBeenCalled();
});

it('does not turn a correctly signed and encrypted address into destination permission', async () => {
  const { alice, bob, keys, offer } = await pair(true, '1.0.0.1');
  await keys(); await alice.post(await alice.prepare(await offer(), 'offer', 1));
  expect(await bob.find('offer')).toBeNull();
});

it.each(['https://example.org', 'https://openagentforum.com/', 'https://openagentforum.com:443',
  'http://openagentforum.com', 'https://user@openagentforum.com', 'https://openagentforum.com.evil.example',
  'http://localhost:9876', 'http://169.254.169.254'])('rejects noncanonical/unapproved hub %s without fetching', async hub => {
  const { b, fetcher } = await pair();
  await expect(async () => PrivateForumMailbox.discover({ hub, channel: scope.channel }, b.agentId, fetcher)).rejects.toBeDefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects tampered or wrong-key outer signatures and even signed nonce/ciphertext corruption', async () => {
  const { a, b, alice, bob, records, keys, offer } = await pair();
  await keys(); await alice.post(await alice.prepare(await offer(), 'offer', 1));
  const good = records[2], ciphertext = good.payload.ciphertext;
  for (const index of [8, 32, ciphertext.length - 1]) {
    const changed = ciphertext.slice(0, index) + (ciphertext[index] === '0' ? '1' : '0') + ciphertext.slice(index + 1);
    records[2] = { ...good, payload: { ciphertext: changed } };
    expect(await bob.find('offer')).toBeNull();
    records[2] = await resign(good, a.signingPrivateKey, { payload: { ciphertext: changed } });
    expect(await bob.find('offer')).toBeNull();
  }
  records[2] = await resign(good, b.signingPrivateKey, {});
  expect(await bob.find('offer')).toBeNull();
  records[2] = good; expect(await bob.find('offer')).not.toBeNull();
});

it('ignores unsigned encryption flags, nonce, cursor and reply references when authenticating/decrypting', async () => {
  const { alice, bob, records, keys, offer } = await pair();
  await keys(); const raw = await offer(); await alice.post(await alice.prepare(raw, 'offer', 1));
  records[2] = { ...records[2], nonce: '0'.repeat(24), encrypted: false, storedSeq: 999999, replyToId: 'fake', ephemeralPublicKey: 'f'.repeat(64) };
  expect(await bob.find('offer')).toBe(raw);
});

it('rejects unknown fields and plaintext fallback, including correctly signed inputs', async () => {
  const { a, alice, bob, records, keys, offer } = await pair();
  await keys(); const raw = await offer(); await alice.post(await alice.prepare(raw, 'offer', 1));
  const good = records[2];
  for (const payload of [{ ...good.payload, address: 'untrusted' }, { ciphertext: 'x' }, { ciphertext: 'aa'.repeat(11000) },
    { ...good.payload, constructor: 'untrusted' }, JSON.parse('{"ciphertext":"aa","__proto__":{}}'), JSON.parse(raw).payload]) {
    records[2] = await resign(good, a.signingPrivateKey, { payload });
    expect(await bob.find('offer')).toBeNull();
  }
  records[2] = JSON.parse(raw); expect(await bob.find('offer')).toBeNull();
});

it('pins only full-key signed, scoped, fresh key bindings and refuses ambiguous keys', async () => {
  const { a, b, alice, bob, records } = await pair();
  const ka = await alice.prepareKey(0), kb = await bob.prepareKey(0);
  await alice.post(ka); await bob.post(kb); const good = records[1];
  for (const payload of [{ ...good.payload, hub: 'https://example.org' }, { ...good.payload, to: b.signingPublicKey },
    { ...good.payload, from: a.signingPublicKey }, { ...good.payload, expiresAt: Date.now() - 1 },
    { ...good.payload, encryptionPublicKey: ['bad'] }, { ...good.payload, prototype: 'bad' }]) {
    records[1] = await resign(good, b.signingPrivateKey, { payload }); expect(await alice.findPeerKey()).toBe(false);
  }
  records[1] = await resign(good, a.signingPrivateKey, {}); expect(await alice.findPeerKey()).toBe(false);
  records[1] = good;
  records.push(await resign(good, b.signingPrivateKey, { payload: { ...good.payload, encryptionPublicKey: a.encryptionPublicKey } }));
  await expect(alice.findPeerKey()).rejects.toMatchObject({ code: 'protocol' });
  records.pop(); records.push({ ...good, storedSeq: 999 });
  expect(await alice.findPeerKey()).toBe(true);
});

it('cannot decrypt an earlier mailbox ciphertext after restart even with the same signing identities and channel', async () => {
  const { a, b, alice, bob, records, keys, offer, fetcher } = await pair();
  await keys(); const raw = await offer(); await alice.post(await alice.prepare(raw, 'offer', 1));
  expect(await bob.find('offer')).toBe(raw); bob.close();
  records.splice(1, 1); // Retain the peer binding/ciphertext, replace only our key announcement.
  const restarted = await PrivateForumMailbox.create(b, a.signingPublicKey, scope, undefined, fetcher); mailboxes.push(restarted);
  await restarted.post(await restarted.prepareKey(2)); expect(await restarted.findPeerKey()).toBe(true);
  expect(await restarted.find('offer')).toBeNull();
});

it('retains a prepare-before-post boundary, disallows plaintext posting and never retries uncertain sends', async () => {
  const { alice, fetcher, offer } = await pair();
  await expect(alice.post(await offer())).rejects.toMatchObject({ code: 'protocol' });
  const raw = await alice.prepareKey(0); expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRejectedValue(new Error('private remote diagnostic'));
  await expect(alice.post(raw)).rejects.toMatchObject({ code: 'io', message: 'Peer stream: io' });
  await expect(alice.post(raw)).rejects.toMatchObject({ code: 'protocol' });
  await expect(alice.findPeerKey()).rejects.toMatchObject({ code: 'protocol' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('requires a matching acknowledgment and does not resubmit successful posts', async () => {
  const { a, alice, fetcher } = await pair();
  const raw = await alice.prepareKey(0);
  fetcher.mockResolvedValueOnce(json({ success: true, envelope: await resign(JSON.parse(raw), a.signingPrivateKey, { id: crypto.randomUUID() }) }));
  await expect(alice.post(raw)).rejects.toMatchObject({ code: 'protocol' });
  await expect(alice.post(raw)).rejects.toMatchObject({ code: 'protocol' });
  expect(fetcher).toHaveBeenCalledOnce();
  const other = await pair(); const key = await other.alice.prepareKey(0); await other.alice.post(key);
  await expect(other.alice.post(key)).rejects.toMatchObject({ code: 'protocol' });
  expect(other.fetcher).toHaveBeenCalledOnce();
});

it('rejects late acknowledgments and an expired invitation without fresh retries', async () => {
  const { alice, bob, records, keys, offer, fetcher } = await pair();
  await keys(); const raw = await offer(), sealed = await alice.prepare(raw, 'offer', 1);
  const expiry = JSON.parse(raw).payload.expiresAt;
  fetcher.mockImplementationOnce(async (_url, options) => {
    const stored = JSON.parse(options?.body as string); records.push(stored);
    vi.spyOn(Date, 'now').mockReturnValue(expiry); return json({ success: true, envelope: stored });
  });
  await expect(alice.post(sealed)).rejects.toMatchObject({ code: 'protocol' });
  expect(await bob.find('offer')).toBeNull();
  await expect(alice.post(sealed)).rejects.toMatchObject({ code: 'protocol' });
});

it('rejects concurrent operations and cannot revive a mailbox closed during a request', async () => {
  const { alice, fetcher } = await pair(); const key = await alice.prepareKey(0);
  let release!: (r: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = expect(alice.post(key)).rejects.toMatchObject({ code: 'closed' });
  await expect(alice.nextSequence()).rejects.toMatchObject({ code: 'busy' });
  alice.close(); release(json({ success: true, envelope: JSON.parse(key) })); await pending;
  await expect(alice.prepareKey(1)).rejects.toMatchObject({ code: 'closed' });
});

it('bounds HTTP bodies and refuses a truncated history; malformed records cannot become invitations', async () => {
  const { alice, bob, records, keys, fetcher } = await pair(); await keys();
  records.push(null, { payload: 'execute this' }, { payload: { ciphertext: '00' } });
  expect(await bob.find('offer')).toBeNull();
  fetcher.mockResolvedValueOnce(json({ messages: Array(100).fill(null) }));
  await expect(alice.find('accept')).rejects.toMatchObject({ code: 'limit' });
  fetcher.mockResolvedValueOnce(json({ messages: ['x'.repeat(262144)] }));
  await expect(alice.find('accept')).rejects.toMatchObject({ code: 'limit' });
});

it('fails public HTTPS redirects and redacts their content without posting or following them', async () => {
  const { b, fetcher, where } = await pair(true);
  fetcher.mockResolvedValueOnce(new Response('private redirect diagnostic', { status: 302, headers: { Location: 'http://127.0.0.1/' } }));
  await expect(PrivateForumMailbox.discover(where, b.agentId, fetcher)).rejects.toMatchObject({ code: 'io', message: 'Peer stream: io' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('checks the local signing-key pair before any key publication', async () => {
  const { a, b, fetcher } = await pair();
  const bad = await PrivateForumMailbox.create({ ...a, signingPrivateKey: b.signingPrivateKey }, b.signingPublicKey, scope, undefined, fetcher);
  mailboxes.push(bad);
  await expect(bad.prepareKey(0)).rejects.toMatchObject({ code: 'protocol' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects authenticated ciphertext with wrong inner context, key references, expiry or schema', async () => {
  const { a, b, alice, records } = await pair();
  const own = JSON.parse(await alice.prepareKey(0));
  // A deliberately handcrafted selected peer, with known fixture-only X25519 keys.
  await alice.post(JSON.stringify(own));
  const peer = await signEnvelope({ channel: scope.channel, sender: b.agentId, type: 'intel', sequence: 0,
    payload: { kind: 'oaf.stream.key.v1', hub: scope.hub, from: b.signingPublicKey, to: a.signingPublicKey,
      expiresAt: Date.now() + 60_000, encryptionPublicKey: b.encryptionPublicKey } }, b.signingPrivateKey);
  records.push(peer); expect(await alice.findPeerKey()).toBe(true);
  const invitation = await signEnvelope({ channel: scope.channel, sender: b.agentId, type: 'intel', sequence: 1,
    payload: { kind: 'oaf.stream.offer.v1', hub: scope.hub, sessionId: 'b'.repeat(64), from: b.signingPublicKey, to: a.signingPublicKey,
      expiresAt: Date.now() + 30_000, protocol: STREAM_PROTOCOL, address: `/ip4/127.0.0.1/tcp/49123/p2p/${peerIdFor(b.signingPublicKey)}` } }, b.signingPrivateKey);
  const bundle = { kind: 'oaf.stream.sealed.v1', hub: scope.hub, from: b.signingPublicKey, to: a.signingPublicKey,
    expiresAt: invitation.payload.expiresAt, fromKeyId: peer.id, fromKeyHash: peer.checksum, toKeyId: own.id, toKeyHash: own.checksum, invitation };
  const encrypted = async (payload: unknown, sequence = 1) => {
    const { ciphertext, nonce } = await encryptPayloadForRecipient(JSON.stringify(payload), own.payload.encryptionPublicKey, b.encryptionPrivateKey);
    return signEnvelope({ channel: scope.channel, sender: b.agentId, type: 'e2ee_blob', sequence,
      payload: { ciphertext: '4f414631' + nonce + ciphertext } }, b.signingPrivateKey);
  };
  for (const change of [{ kind: 'other' }, { hub: 'https://example.org' }, { from: a.signingPublicKey }, { to: b.signingPublicKey },
    { fromKeyId: crypto.randomUUID() }, { fromKeyHash: '0'.repeat(64) }, { toKeyId: crypto.randomUUID() }, { toKeyHash: '0'.repeat(64) },
    { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 60_000 }, { constructor: 'untrusted' },
    { invitation: { ...invitation, sequence: 999 } }, { invitation: { command: 'UNTRUSTED_FIXTURE_ONLY' } }]) {
    records[2] = await encrypted({ ...bundle, ...change }); expect(await alice.find('offer')).toBeNull();
  }
  records[2] = await encrypted(bundle, 2); expect(await alice.find('offer')).toBeNull();
  records[2] = await encrypted(bundle); expect(await alice.find('offer')).toBe(JSON.stringify(invitation));
});

it('does not fall back to plaintext when the selected peer supplies an unusable X25519 key', async () => {
  const { b, alice, bob, records, offer, fetcher } = await pair();
  await alice.post(await alice.prepareKey(0)); await bob.post(await bob.prepareKey(0));
  records[1] = await resign(records[1], b.signingPrivateKey, { payload: { ...records[1].payload, encryptionPublicKey: '0'.repeat(64) } });
  expect(await alice.findPeerKey()).toBe(true);
  const count = fetcher.mock.calls.length;
  await expect(alice.prepare(await offer(), 'offer', 1)).rejects.toMatchObject({ code: 'protocol' });
  expect(fetcher.mock.calls).toHaveLength(count);
  expect(records).toHaveLength(2);
});

it('snapshots local identity/scope before async setup and enforces the monotonic lifetime', async () => {
  const { a, b, fetcher } = await pair(); const identity = { ...a }, mutableScope = { ...scope };
  const creating = PrivateForumMailbox.create(identity, b.signingPublicKey, mutableScope, undefined, fetcher);
  identity.signingPrivateKey = b.signingPrivateKey; mutableScope.hub = 'https://example.org';
  const mailbox = await creating; mailboxes.push(mailbox);
  expect(mailbox.scope).toEqual(scope);
  const raw = await mailbox.prepareKey(0); expect((await verifyEnvelope(JSON.parse(raw), a.signingPublicKey)).valid).toBe(true);
  const later = performance.now() + 60_001; vi.spyOn(performance, 'now').mockReturnValue(later);
  await expect(mailbox.post(raw)).rejects.toMatchObject({ code: 'closed' });
  expect(fetcher).not.toHaveBeenCalled();
});
