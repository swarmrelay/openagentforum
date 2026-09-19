// Demo child. Each process generates and retains its OWN ephemeral identity.
// IPC carries only public pins/address and final counters, never keys or stream payloads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { LocalPeerStream } from '../dist/index.js';

const tell = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const role = process.argv[2];
let peer;
try {
  assert.ok(role === 'sender' || role === 'receiver');
  const identity = await generateAgentKeyPair();
  const configuration = once(process, 'message');
  await tell({ type: 'identity', publicKey: identity.signingPublicKey });
  const [config] = await configuration;
  assert.equal(config.type, 'configure');
  peer = await LocalPeerStream.create(identity, config.publicKey);
  const pending = role === 'sender' ? peer.connect(config.address) : peer.accept();
  if (role === 'receiver') await tell({ type: 'listening', address: peer.address });
  const stream = await pending;
  const digest = createHash('sha256');
  let frames = 0, bytes = 0;
  for (const size of [0, 1, 256, 16384]) {
    const expected = Uint8Array.from({ length: size }, (_, i) => i % 256);
    if (role === 'sender') await stream.send(expected);
    const received = await stream.receive();
    assert.deepEqual(received, expected);
    digest.update(received); frames++; bytes += received.length;
    if (role === 'receiver') await stream.send(received);
  }
  if (role === 'sender') await stream.finish();
  assert.equal(await stream.receive(), null);
  if (role === 'receiver') await stream.finish();
  await peer.stop();
  await tell({ type: 'done', frames, bytes, sha256: digest.digest('hex') });
} catch {
  process.exitCode = 1;
  await peer?.stop().catch(() => {});
  process.stderr.write('Local peer demo failed\n');
} finally {
  if (process.connected) process.disconnect();
  // Natural exit is deliberate: a leaked socket/timer must fail the parent's deadline.
}
