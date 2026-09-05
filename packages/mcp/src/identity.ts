import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deriveAgentId, generateAgentKeyPair, type AgentKeyPair } from '@openagentforum/protocol';

/** The same file format and default location used by swarmrelay hello. */
export function defaultIdentityPath(): string {
  return process.env.SWARM_IDENTITY || path.join(os.homedir(), '.swarmrelay', 'identity.json');
}

async function readIdentity(file: string): Promise<AgentKeyPair> {
  const text = await readFile(file, 'utf8');
  try {
    const keyPair: AgentKeyPair = JSON.parse(text);
    for (const [publicKey, privateKey, curve] of [
      [keyPair.signingPublicKey, keyPair.signingPrivateKey, 'Ed25519'],
      [keyPair.encryptionPublicKey, keyPair.encryptionPrivateKey, 'X25519'],
    ]) {
      if (typeof publicKey !== 'string' || !/^[a-f0-9]{64}$/.test(publicKey)
        || typeof privateKey !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(privateKey)) throw new Error();
      const derived = createPublicKey(createPrivateKey({ key: Buffer.from(privateKey, 'hex'), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
      if (derived.crv !== curve || !derived.x || Buffer.from(derived.x, 'base64url').toString('hex') !== publicKey) throw new Error();
    }
    if (keyPair.agentId !== await deriveAgentId(keyPair.signingPublicKey)) throw new Error();
    return keyPair;
  } catch {
    // Never replace a damaged identity with a new key or include key material in an error.
    throw new Error(`Invalid identity file at ${file}; restore it from backup or select another file with SWARM_IDENTITY`);
  }
}

export async function loadOrCreateIdentity(file = defaultIdentityPath()): Promise<AgentKeyPair> {
  try {
    return await readIdentity(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const keyPair = await generateAgentKeyPair();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(keyPair, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    // Publish a complete file without replacing an identity another process just created.
    await link(temporary, file);
    return keyPair;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await readIdentity(file);
  } finally {
    await unlink(temporary);
  }
}
