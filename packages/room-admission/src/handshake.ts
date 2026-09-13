/** Offline, unpublished Noise IK laboratory. No listener, storage or room authorization. */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { Cipher, Noise, clearNoise, type NoiseCipher, type NoiseKeyPair, type NoiseState } from './noise-driver.js';
import { verifyRoomKeyBindings, roomNoisePrologue, type RoomKeyBundle, type RoomKeyPins } from './key-bindings.js';

export const ROOM_NOISE_LIMITS = Object.freeze({ plaintextBytes: 16_384, messagesPerDirection: 1024,
  handshakeLifetimeMs: 60_000, sessionLifetimeMs: 300_000 } as const);
type Phase = 'owner-start' | 'peer-first' | 'owner-reply' | 'peer-confirm' | 'owner-confirm' | 'ready' | 'closed';
export interface RoomNoiseSession {
  readonly phase: Phase;
  start(): Buffer;
  receiveHandshake(packet: Uint8Array): Buffer | null;
  seal(plaintext: Uint8Array): Buffer;
  open(packet: Uint8Array): Buffer;
  close(): void;
}
export interface RoomNoiseOptions {
  role: 'owner' | 'peer';
  bundle: RoomKeyBundle;
  pins: RoomKeyPins;
  /** Caller-owned room X25519 PKCS#8 key, never sent or persisted by this module. */
  encryptionPrivateKey: string;
  now: () => number;
}
function localKeys(pkcs8: string, expected: string): NoiseKeyPair {
  if (typeof pkcs8 !== 'string' || !/^(?:[0-9a-f]{2}){1,256}$/.test(pkcs8)) throw new Error('Invalid local room key');
  const der = Buffer.from(pkcs8, 'hex');
  try {
    const key = createPrivateKey({ key: der, type: 'pkcs8', format: 'der' });
    if (key.asymmetricKeyType !== 'x25519') throw new Error('Invalid local room key');
    const publicKey = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url');
    if (publicKey.toString('hex') !== expected) throw new Error('Invalid local room key');
    const secretKey = Buffer.from(key.export({ format: 'jwk' }).d!, 'base64url');
    return { publicKey, secretKey };
  } finally { der.fill(0); }
}

/** Always reverify raw signed bindings; no caller-supplied verified fast path. */
export async function createRoomNoiseSession(options: RoomNoiseOptions): Promise<RoomNoiseSession> {
  let keys: NoiseKeyPair | undefined;
  let state: NoiseState | undefined;
  try {
    const { role, encryptionPrivateKey, now } = options;
    if ((role !== 'owner' && role !== 'peer') || typeof now !== 'function') throw new Error('Invalid options');
    const binding = await verifyRoomKeyBindings(options.bundle, options.pins);
    const local = role === 'owner' ? binding.owner : binding.peer;
    const remote = role === 'owner' ? binding.peer : binding.owner;
    keys = localKeys(encryptionPrivateKey, local.encryptionPublicKey);
    state = new Noise('IK', role === 'owner', keys);
    state.initialise(roomNoisePrologue(binding), Buffer.from(remote.encryptionPublicKey, 'hex'));
    return new Session(role, state, remote.encryptionPublicKey, now);
  } catch {
    if (state) clearNoise(state);
    keys?.secretKey.fill(0);
    throw new Error('Room handshake setup failed');
  }
}

class Session implements RoomNoiseSession {
  #phase: Phase;
  #state: NoiseState | null;
  #tx: NoiseCipher | null = null;
  #rx: NoiseCipher | null = null;
  readonly #remoteKey: string;
  readonly #now: () => number;
  readonly #started: number;
  #highWater: number;
  #sent = 0;
  #received = 0;

  constructor(role: 'owner' | 'peer', state: NoiseState, remoteKey: string, now: () => number) {
    this.#phase = role === 'owner' ? 'owner-start' : 'peer-first';
    this.#state = state;
    this.#remoteKey = remoteKey;
    this.#now = now;
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time > Number.MAX_SAFE_INTEGER - ROOM_NOISE_LIMITS.sessionLifetimeMs) {
      throw new Error('Invalid clock');
    }
    this.#started = this.#highWater = time;
  }
  get phase(): Phase { return this.#phase; }
  close(): void {
    this.#phase = 'closed';
    if (this.#state) clearNoise(this.#state);
    this.#state = null;
    this.#tx?.key?.fill(0);
    this.#rx?.key?.fill(0);
    this.#tx = this.#rx = null;
  }
  #guard<T>(operation: () => T): T {
    let result: T | undefined;
    try {
      if (this.#phase === 'closed') throw new Error('Closed');
      const lifetime = this.#phase === 'ready' ? ROOM_NOISE_LIMITS.sessionLifetimeMs : ROOM_NOISE_LIMITS.handshakeLifetimeMs;
      this.#checkTime(lifetime);
      result = operation();
      // Keep the original deadline even when this operation finishes the handshake.
      this.#checkTime(lifetime);
      return result;
    } catch {
      if (Buffer.isBuffer(result)) result.fill(0);
      this.close();
      // Never return a driver exception, key, input body, plaintext or SQL/path detail.
      throw new Error('Room session failed or closed');
    }
  }
  #checkTime(lifetime: number): void {
    const time = this.#now();
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid clock');
    this.#highWater = Math.max(time, this.#highWater);
    if (this.#highWater - this.#started >= lifetime) throw new Error('Expired');
  }
  #packet(value: Uint8Array, min: number, max = min): Buffer {
    if (!(value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max
        || value.buffer instanceof SharedArrayBuffer) throw new Error('Invalid packet');
    return Buffer.from(value); // dependency clears some input views; caller retains its bytes
  }
  #split(): void {
    const state = this.#state!;
    if (!state.complete || !state.tx || !state.rx || state.rs?.toString('hex') !== this.#remoteKey) {
      throw new Error('Invalid peer');
    }
    this.#tx = new Cipher(Buffer.from(state.tx));
    this.#rx = new Cipher(Buffer.from(state.rx));
    clearNoise(state);
    this.#state = null;
  }
  start(): Buffer {
    return this.#guard(() => {
      if (this.#phase !== 'owner-start') throw new Error('Invalid phase');
      const packet = this.#state!.send(); // no early application payload
      if (packet.length !== 96) throw new Error('Invalid handshake');
      this.#phase = 'owner-reply';
      return packet;
    });
  }
  receiveHandshake(value: Uint8Array): Buffer | null {
    return this.#guard(() => {
      switch (this.#phase) {
        case 'peer-first': {
          const packet = this.#packet(value, 96);
          if (this.#state!.recv(packet).length !== 0 || this.#state!.rs?.toString('hex') !== this.#remoteKey) {
            throw new Error('Invalid initiator');
          }
          const reply = this.#state!.send();
          if (reply.length !== 48) throw new Error('Invalid handshake');
          this.#split();
          this.#phase = 'peer-confirm';
          return reply;
        }
        case 'owner-reply': {
          if (this.#state!.recv(this.#packet(value, 48)).length !== 0) throw new Error('Invalid responder');
          this.#split();
          this.#phase = 'owner-confirm';
          return this.#tx!.encrypt(Buffer.from([1]));
        }
        case 'peer-confirm': {
          const confirm = this.#rx!.decrypt(this.#packet(value, 17));
          if (confirm.length !== 1 || confirm[0] !== 1) throw new Error('Invalid confirmation');
          const reply = this.#tx!.encrypt(Buffer.from([2]));
          this.#phase = 'ready';
          return reply;
        }
        case 'owner-confirm': {
          const confirm = this.#rx!.decrypt(this.#packet(value, 17));
          if (confirm.length !== 1 || confirm[0] !== 2) throw new Error('Invalid confirmation');
          this.#phase = 'ready';
          return null;
        }
        default: throw new Error('Invalid phase');
      }
    });
  }
  seal(value: Uint8Array): Buffer {
    return this.#guard(() => {
      if (this.#phase !== 'ready' || this.#sent >= ROOM_NOISE_LIMITS.messagesPerDirection) throw new Error('Not ready or full');
      const plaintext = this.#packet(value, 0, ROOM_NOISE_LIMITS.plaintextBytes);
      const frame = Buffer.concat([Buffer.from([3]), plaintext]);
      try {
        const packet = this.#tx!.encrypt(frame);
        this.#sent++;
        return packet;
      } finally { plaintext.fill(0); frame.fill(0); }
    });
  }
  open(value: Uint8Array): Buffer {
    return this.#guard(() => {
      if (this.#phase !== 'ready' || this.#received >= ROOM_NOISE_LIMITS.messagesPerDirection) throw new Error('Not ready or full');
      const plaintext = this.#rx!.decrypt(this.#packet(value, 17, ROOM_NOISE_LIMITS.plaintextBytes + 17));
      try {
        if (plaintext[0] !== 3) throw new Error('Not an application frame');
        this.#received++;
        return Buffer.from(plaintext.subarray(1));
      } finally { plaintext.fill(0); }
    });
  }
}
