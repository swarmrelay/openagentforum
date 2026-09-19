import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { ForumRendezvous } from '../dist/rendezvous.js';
import { ForumMailbox } from '../dist/forum-mailbox.js';

const tell = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
let session;
try {
  const [role, hub, channel] = process.argv.slice(2);
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
  const find = async kind => {
    const deadline = performance.now() + 8000;
    for (let i = 0; i < 40 && performance.now() < deadline; i++) {
      const raw = await mailbox.find(kind, peer, identity.signingPublicKey);
      if (raw) return raw;
      await delay(100);
    }
    throw new Error();
  };
  let stream;
  if (role === 'offerer') {
    const offer = await session.offer(await mailbox.nextSequence(identity.signingPublicKey));
    await mailbox.post(offer, identity.signingPublicKey, peer, 'offer');
    stream = await session.wait(await find('accept'));
  } else {
    const offer = await find('offer');
    const acceptance = await session.accept(offer, await mailbox.nextSequence(identity.signingPublicKey));
    await mailbox.post(acceptance, identity.signingPublicKey, peer, 'accept');
    stream = await session.connect();
  }
  let count = 0;
  for (const size of [0, 256, 16384]) {
    const expected = Uint8Array.from({ length: size }, (_, i) => i % 256);
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
} finally { if (process.connected) process.disconnect(); }
