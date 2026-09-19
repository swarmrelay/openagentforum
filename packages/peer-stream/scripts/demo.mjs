// No network outside loopback, files, persistent keys, hub calls or remote service changes.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const children = [];
let deadline;
try {
  const result = await new Promise((resolve, reject) => {
    const pins = {}, results = {};
    let configured = false, addressSent = false, exited = 0;
    const fail = () => reject(new Error('Local two-process stream demo failed'));
    deadline = setTimeout(fail, 15_000);
    for (const role of ['sender', 'receiver']) {
      const child = fork(fileURLToPath(new URL('./peer.mjs', import.meta.url)), [role], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [],
      });
      children.push(child);
      // Child output is not part of the protocol; drain but never print it or retain it.
      child.stdout.resume(); child.stderr.resume();
      child.on('error', fail);
      child.on('message', message => {
        try {
          if (message.type === 'identity') {
            assert.equal(pins[role], undefined);
            assert.match(message.publicKey, /^[0-9a-f]{64}$/);
            pins[role] = message.publicKey;
            if (pins.sender && pins.receiver && !configured) {
              configured = true;
              children[1].send({ type: 'configure', publicKey: pins.sender }, error => { if (error) fail(); });
            }
          } else if (message.type === 'listening') {
            assert.equal(role, 'receiver'); assert.equal(addressSent, false);
            assert.match(message.address, /^\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\/[a-zA-Z0-9]+$/);
            addressSent = true;
            children[0].send({ type: 'configure', publicKey: pins.receiver, address: message.address }, error => { if (error) fail(); });
          } else if (message.type === 'done') {
            assert.equal(results[role], undefined);
            assert.equal(message.frames, 4); assert.equal(message.bytes, 16641);
            assert.match(message.sha256, /^[0-9a-f]{64}$/);
            results[role] = message;
          } else fail();
        } catch { fail(); }
      });
      child.on('close', code => {
        if (code !== 0 || !results[role]) { fail(); return; }
        if (++exited === 2) {
          try { assert.deepEqual(results.sender, results.receiver); resolve(results.sender); }
          catch { fail(); }
        }
      });
    }
  });
  console.log(JSON.stringify({ ok: true, transport: 'loopback-tcp+libp2p-noise+yamux', processes: 2,
    framesEachWay: result.frames, bytesEachWay: result.bytes, sha256: result.sha256, naturalExit: true }));
} catch {
  process.exitCode = 1;
  console.error('Local two-process stream demo failed');
} finally {
  clearTimeout(deadline);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
