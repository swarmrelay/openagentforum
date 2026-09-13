/** Narrow types for the pinned, Node-only noise-handshake 4.2.0 dependency. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export interface NoiseKeyPair { publicKey: Buffer; secretKey: Buffer }
export interface NoiseState {
  s: NoiseKeyPair;
  e: NoiseKeyPair | null;
  rs: Buffer | null;
  re: Buffer | null;
  key: Buffer | null;
  digest: Buffer | null;
  chainingKey: Buffer | null;
  tx: Buffer | null;
  rx: Buffer | null;
  hash: Buffer | null;
  complete: boolean;
  initialise(prologue: Buffer, remoteStatic?: Buffer): void;
  send(payload?: Buffer): Buffer;
  recv(packet: Buffer): Buffer;
}
export interface NoiseCipher {
  key: Buffer | null;
  encrypt(plaintext: Buffer): Buffer;
  decrypt(ciphertext: Buffer): Buffer;
}
export const Noise = require('noise-handshake') as new (pattern: 'IK', initiator: boolean, keys: NoiseKeyPair) => NoiseState;
export const Cipher = require('noise-handshake/cipher') as new (key: Buffer) => NoiseCipher;

/** Best effort on reachable buffers, NOT a secure-erasure guarantee for JS/native temporaries. */
export function clearNoise(state: NoiseState): void {
  for (const bytes of [state.s.secretKey, state.s.publicKey, state.e?.secretKey, state.e?.publicKey,
    state.rs, state.re, state.key, state.digest, state.chainingKey, state.tx, state.rx, state.hash]) bytes?.fill(0);
}
