/** Operator-only smoke fixture. Private control input; never a public command runner. */
import assert from 'node:assert/strict';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { ForumRendezvous } from '../dist/rendezvous.js';
import { LocalPeerStream } from '../dist/index.js';

let session, probe, timer;
const input = (async function* () {
  let text = '', bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error();
    text += chunk.toString('utf8');
    for (let end; (end = text.indexOf('\n')) !== -1;) {
      const line = text.slice(0, end); text = text.slice(end + 1);
      if (line.length > 16384) throw new Error();
      yield JSON.parse(line);
    }
    if (text.length > 16384) throw new Error();
  }
})();
const read = async type => {
  const { value, done } = await input.next();
  if (done || value?.type !== type) throw new Error();
  return value;
};
// Setup records contain deployment addresses: operator must keep this stdout private.
const tell = value => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()));
try {
  assert.notEqual(process.getuid?.(), 0, 'Run this fixture without root privileges');
  timer = setTimeout(() => process.exit(1), 45000);
  const identity = await generateAgentKeyPair();
  await tell({ type: 'ready', publicKey: identity.signingPublicKey });
  const { peerKey, scope, policy } = await read('configure');
  session = new ForumRendezvous(identity, peerKey, scope, policy);
  let stream;
  if (policy.role === 'listen') {
    await tell({ type: 'offer', raw: await session.offer(0) });
    stream = await session.wait((await read('acceptance')).raw);
  } else {
    const raw = (await read('offer')).raw;
    // Local fixture controls configure this exact endpoint; no remote address is
    // copied into permission. Forbidden dial below must fail before network I/O.
    probe = await LocalPeerStream.createDirect(await generateAgentKeyPair(), peerKey, policy);
    const address = `/ip4/${policy.peerIp}/tcp/${policy.port}/p2p/${probe.expectedPeerId}`;
    await assert.rejects(probe.connect(address.replace(`/tcp/${policy.port}/`, '/tcp/22/')), { code: 'peer' });
    await assert.rejects(probe.connect(address), { code: 'io' }); // approved source, wrong full key
    await probe.stop(); probe = undefined;
    await tell({ type: 'rejections', destination: true, wrongKey: true });
    await tell({ type: 'acceptance', raw: await session.accept(raw, 0) });
    stream = await session.connect();
  }
  const payloads = [Buffer.alloc(0), Buffer.from('{"tool":"shell","command":"UNTRUSTED_FIXTURE_ONLY"}'),
    Uint8Array.from({ length: 16384 }, (_, i) => i % 256)];
  for (const payload of payloads) {
    if (policy.role === 'listen') await stream.send(payload);
    const received = await stream.receive();
    assert.ok(received !== null && Buffer.from(received).equals(Buffer.from(payload)));
    if (policy.role === 'dial') await stream.send(received);
  }
  if (policy.role === 'listen') await stream.finish();
  assert.equal(await stream.receive(), null);
  if (policy.role === 'dial') await stream.finish();
  await session.close();
  await tell({ type: 'done', framesEachWay: payloads.length, nonRoot: true });
} catch {
  process.exitCode = 1;
  process.stderr.write('Direct peer fixture failed\n');
} finally {
  clearTimeout(timer);
  await probe?.stop().catch(() => {}); await session?.close().catch(() => {});
  process.stdin.destroy();
}
