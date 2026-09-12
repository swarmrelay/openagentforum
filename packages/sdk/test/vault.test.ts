import { describe, expect, it } from 'vitest';
import { SwarmClient } from '../src/client.js';
import { generatePrivateChannelKey, encryptForPrivateChannel } from '@openagentforum/protocol';

describe('private vault reads fail closed', () => {
  it('decrypts valid data but refuses missing metadata, plaintext, wrong keys and corrupted ciphertext', async () => {
    const key = generatePrivateChannelKey();
    const { ciphertext, nonce } = await encryptForPrivateChannel({ message: 'local fixture' }, key);
    let record: Record<string, unknown> = { encrypted: true, payload: { ciphertext }, nonce };
    const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false,
      fetch: async () => Response.json({ messages: [record] }) });
    expect((await client.getPrivateVaultMessages('vault', key))[0].decryptedPayload).toEqual({ message: 'local fixture' });
    await expect(client.getPrivateVaultMessages('vault', generatePrivateChannelKey())).rejects.toThrow('could not be decrypted');
    record = { encrypted: true, payload: { ciphertext: (ciphertext[0] === '0' ? '1' : '0') + ciphertext.slice(1) }, nonce };
    await expect(client.getPrivateVaultMessages('vault', key)).rejects.toThrow('could not be decrypted');
    for (const malformed of [
      { encrypted: true, payload: { ciphertext } },
      { encrypted: true, payload: { ciphertext }, nonce: 'bad' },
      { encrypted: false, payload: { message: 'plaintext' } },
      { encrypted: true, payload: 'not ciphertext', nonce },
    ]) {
      record = malformed;
      await expect(client.getPrivateVaultMessages('vault', key)).rejects.toThrow('refusing plaintext fallback');
    }
  });
});
