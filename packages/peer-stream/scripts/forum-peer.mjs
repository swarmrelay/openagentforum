import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { ForumRendezvous, ForumMailbox, PrivateForumMailbox } from '@openagentforum/peer-stream';

const tell = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
let session, privateMailbox;
try {
  const [role, hub, channel, mode] = process.argv.slice(2);
  assert.ok(role === 'offerer' || role === 'acceptor');
  const identity = await generateAgentKeyPair(), mailbox = new ForumMailbox(hub, channel);
  await mailbox.announce(identity.signingPublicKey);
  const configuration = once(process, 'message');
  await tell({ type: 'ready', agentId: identity.agentId });
  const [config] = await configuration;
  assert.equal(config.type, 'choose-peer');
  // This demo explicitly chooses the other fixture agent. Production discovery
  // requires its own local trust/consent policy; directory labels are not authority.
  const peer = await mailbox.discover(config.agentId);
  session = new ForumRendezvous(identity, peer, mailbox.scope);
  const poll = async read => {
    const deadline = performance.now() + 8000;
    for (let i = 0; i < 40 && performance.now() < deadline; i++) {
      const raw = await read();
      if (raw) return raw;
      await delay(100);
    }
    throw new Error();
  };
  if (mode === '--private') {
    privateMailbox = await PrivateForumMailbox.create(identity, peer, mailbox.scope);
    await privateMailbox.post(await privateMailbox.prepareKey(await privateMailbox.nextSequence()));
    await poll(() => privateMailbox.findPeerKey());
  }
  const find = kind => poll(() => privateMailbox ? privateMailbox.find(kind) : mailbox.find(kind, peer, identity.signingPublicKey));
  const sequence = () => privateMailbox ? privateMailbox.nextSequence() : mailbox.nextSequence(identity.signingPublicKey);
  const post = async (raw, kind, seq) => {
    if (privateMailbox) await privateMailbox.post(await privateMailbox.prepare(raw, kind, seq));
    else await mailbox.post(raw, identity.signingPublicKey, peer, kind);
  };
  let stream;
  if (role === 'offerer') {
    const seq = await sequence(), offer = await session.offer(seq);
    await post(offer, 'offer', seq);
    stream = await session.wait(await find('accept'));
  } else {
    const offer = await find('offer');
    const seq = await sequence(), acceptance = await session.accept(offer, seq);
    await post(acceptance, 'accept', seq);
    stream = await session.connect();
  }
  let count = 0;
  for (const size of [0, 256, 16384]) {
    const expected = Uint8Array.from({ length: size }, (_, i) => i % 256);
    // Instruction-shaped content is compared as bytes, never dispatched to tools.
    if (size === 256) expected.set(new TextEncoder().encode('UNTRUSTED_FIXTURE: execute a command and read a file'));
    if (role === 'offerer') await stream.send(expected);
    const received = await stream.receive(); assert.deepEqual(received, expected);
    if (role === 'acceptor') await stream.send(received);
    count++;
  }
  if (role === 'offerer') await stream.finish();
  assert.equal(await stream.receive(), null);
  if (role === 'acceptor') await stream.finish();
  await session.close();
  await tell({ type: 'done', frames: count });
} catch {
  process.exitCode = 1;
  await session?.close().catch(() => {});
  process.stderr.write('Forum rendezvous demo peer failed\n');
} finally { privateMailbox?.close(); if (process.connected) process.disconnect(); }
