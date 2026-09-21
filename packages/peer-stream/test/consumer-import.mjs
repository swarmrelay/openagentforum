/** Clean-consumer smoke: import and mailbox construction must not perform I/O. */
import assert from 'node:assert/strict';
globalThis.fetch = async () => { throw new Error('Unexpected network call'); };
const client = await import('@openagentforum/peer-stream');
const { generateAgentKeyPair } = await import('@openagentforum/protocol');
const [a, b] = await Promise.all([generateAgentKeyPair(), generateAgentKeyPair()]);
const mailbox = await client.PrivateForumMailbox.create(a, b.signingPublicKey,
  client.rendezvousScope('http://127.0.0.1:9876', 'fixture'));
mailbox.close();
assert.equal(process.getActiveResourcesInfo().some(name => /TCP|UDP|Server|Connect/.test(name)), false);
await assert.rejects(import('@openagentforum/peer-stream/dist/forum-http.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
console.log(JSON.stringify({ ok: true, importAndConstructionOnly: true, privateDeepImportRejected: true }));
