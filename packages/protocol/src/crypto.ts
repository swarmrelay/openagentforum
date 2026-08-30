/**
 * Cryptographic Primitives for OpenAgentForum & SwarmRelay
 * Built entirely on standard Web Crypto API (Ed25519 & X25519 + AES-GCM)
 * Zero external dependencies, fully compatible with Cloudflare Workers, Node.js 20+, Bun, and Browsers.
 */

import type { MessageEnvelope, MessageType } from './types.js';

/**
 * Deterministic JSON stringify (keys recursively sorted, no spacing)
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeJson(item)).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`
  );
  return '{' + pairs.join(',') + '}';
}

/**
 * Convert BufferSource / Uint8Array to Hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert Hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * SHA-256 Hash returning Hex string
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return bytesToHex(new Uint8Array(hashBuffer));
}

/**
 * Derive Agent ID from Ed25519 public key hex
 * Format: agent_<sha256(pubkey)[0..16]>
 */
export async function deriveAgentId(publicKeyHex: string): Promise<string> {
  const hash = await sha256Hex(publicKeyHex.toLowerCase());
  return `agent_${hash.substring(0, 16)}`;
}

export interface AgentKeyPair {
  agentId: string;
  signingPublicKey: string;    // Hex Ed25519 public key (32 bytes)
  signingPrivateKey: string;   // Hex Ed25519 private key (PKCS#8)
  encryptionPublicKey: string; // Hex X25519 public key (32 bytes)
  encryptionPrivateKey: string;// Hex X25519 private key (PKCS#8)
}

/**
 * Generate complete Agent Key Pair (Ed25519 for signing, X25519 for encryption)
 */
export async function generateAgentKeyPair(): Promise<AgentKeyPair> {
  // 1. Generate Ed25519 Signing Key
  const edKeyPair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const rawEdPub = await crypto.subtle.exportKey('raw', edKeyPair.publicKey);
  const pkcs8EdPriv = await crypto.subtle.exportKey('pkcs8', edKeyPair.privateKey);

  const signingPublicKey = bytesToHex(new Uint8Array(rawEdPub));
  const signingPrivateKey = bytesToHex(new Uint8Array(pkcs8EdPriv));
  const agentId = await deriveAgentId(signingPublicKey);

  // 2. Generate X25519 Encryption Key
  const xKeyPair = (await crypto.subtle.generateKey('X25519', true, ['deriveKey', 'deriveBits'])) as CryptoKeyPair;
  const rawXPub = await crypto.subtle.exportKey('raw', xKeyPair.publicKey);
  const pkcs8XPriv = await crypto.subtle.exportKey('pkcs8', xKeyPair.privateKey);

  const encryptionPublicKey = bytesToHex(new Uint8Array(rawXPub));
  const encryptionPrivateKey = bytesToHex(new Uint8Array(pkcs8XPriv));

  return {
    agentId,
    signingPublicKey,
    signingPrivateKey,
    encryptionPublicKey,
    encryptionPrivateKey,
  };
}

/**
 * Import Ed25519 private key from PKCS#8 Hex
 */
async function importEdPrivateKey(privateKeyHex: string): Promise<CryptoKey> {
  const bytes = hexToBytes(privateKeyHex);
  return await crypto.subtle.importKey('pkcs8', bytes as BufferSource, { name: 'Ed25519' }, false, ['sign']);
}

/**
 * Import Ed25519 public key from Raw 32-byte Hex
 */
async function importEdPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  const bytes = hexToBytes(publicKeyHex);
  return await crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'Ed25519' }, true, ['verify']);
}

/**
 * Calculate the canonical string to be signed for an envelope
 */
export function getEnvelopeSignString(params: {
  id: string;
  channel: string;
  sender: string;
  type: MessageType;
  sequence: number;
  timestamp: number;
  checksum: string;
}): string {
  return `${params.id}|${params.channel}|${params.sender}|${params.type}|${params.sequence}|${params.timestamp}|${params.checksum}`;
}

/**
 * Sign an envelope with Ed25519
 */
export async function signEnvelope<T extends Record<string, unknown> | string>(
  params: {
    id?: string;
    channel: string;
    sender: string;
    type: MessageType;
    sequence?: number;
    timestamp?: number;
    payload: T;
    replyToId?: string;
    encrypted?: boolean;
    recipientKeys?: Record<string, string>;
    ephemeralPublicKey?: string;
    nonce?: string;
  },
  signingPrivateKeyHex: string
): Promise<MessageEnvelope<T>> {
  const id = params.id || crypto.randomUUID();
  const sequence = params.sequence ?? 0;
  const timestamp = params.timestamp ?? Date.now();
  const canonicalPayload = canonicalizeJson(params.payload);
  const checksum = await sha256Hex(canonicalPayload);

  const signString = getEnvelopeSignString({
    id,
    channel: params.channel,
    sender: params.sender,
    type: params.type,
    sequence,
    timestamp,
    checksum,
  });

  const privKey = await importEdPrivateKey(signingPrivateKeyHex);
  const sigBuffer = await crypto.subtle.sign('Ed25519', privKey, new TextEncoder().encode(signString));
  const signature = bytesToHex(new Uint8Array(sigBuffer));

  return {
    id,
    channel: params.channel,
    sender: params.sender,
    type: params.type,
    sequence,
    timestamp,
    payload: params.payload,
    signature,
    checksum,
    replyToId: params.replyToId,
    encrypted: params.encrypted,
    recipientKeys: params.recipientKeys,
    ephemeralPublicKey: params.ephemeralPublicKey,
    nonce: params.nonce,
  };
}

/**
 * Verify a message envelope's checksum and Ed25519 signature
 */
export async function verifyEnvelope(
  envelope: MessageEnvelope<any>,
  signingPublicKeyHex: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    // 1. Verify Checksum
    const canonicalPayload = canonicalizeJson(envelope.payload);
    const calculatedChecksum = await sha256Hex(canonicalPayload);
    if (calculatedChecksum.toLowerCase() !== envelope.checksum.toLowerCase()) {
      return { valid: false, error: 'Payload checksum mismatch (data was modified)' };
    }

    // 2. Verify Agent ID matches public key
    const expectedAgentId = await deriveAgentId(signingPublicKeyHex);
    if (envelope.sender.toLowerCase() !== expectedAgentId.toLowerCase()) {
      return { valid: false, error: `Sender ID ${envelope.sender} does not match public key fingerprint ${expectedAgentId}` };
    }

    // 3. Verify Ed25519 Signature
    const signString = getEnvelopeSignString({
      id: envelope.id,
      channel: envelope.channel,
      sender: envelope.sender,
      type: envelope.type,
      sequence: envelope.sequence,
      timestamp: envelope.timestamp,
      checksum: envelope.checksum,
    });

    const pubKey = await importEdPublicKey(signingPublicKeyHex);
    const sigBytes = hexToBytes(envelope.signature);
    const valid = await crypto.subtle.verify(
      'Ed25519',
      pubKey,
      sigBytes as BufferSource,
      new TextEncoder().encode(signString)
    );

    if (!valid) {
      return { valid: false, error: 'Invalid Ed25519 signature' };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}

/**
 * End-to-End Encryption (E2EE) using X25519 ECDH + AES-256-GCM
 */
export async function encryptPayloadForRecipient(
  payload: Record<string, unknown> | string,
  recipientX25519PubKeyHex: string,
  senderX25519PrivKeyHex: string
): Promise<{ ciphertext: string; nonce: string }> {
  // 1. Import sender private key & recipient public key
  const senderPriv = await crypto.subtle.importKey(
    'pkcs8',
    hexToBytes(senderX25519PrivKeyHex) as BufferSource,
    { name: 'X25519' },
    false,
    ['deriveBits', 'deriveKey']
  );
  const recipientPub = await crypto.subtle.importKey(
    'raw',
    hexToBytes(recipientX25519PubKeyHex) as BufferSource,
    { name: 'X25519' },
    false,
    []
  );

  // 2. Derive shared AES-GCM Key (256 bits)
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'X25519', public: recipientPub },
    senderPriv,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  // 3. Encrypt payload with random 12-byte IV/nonce
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = typeof payload === 'string' ? payload : canonicalizeJson(payload);
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    sharedKey,
    new TextEncoder().encode(plaintext)
  );

  return {
    ciphertext: bytesToHex(new Uint8Array(encryptedBuffer)),
    nonce: bytesToHex(nonce),
  };
}

/**
 * Decrypt E2EE payload using X25519 ECDH + AES-256-GCM
 */
export async function decryptPayloadFromSender(
  ciphertextHex: string,
  nonceHex: string,
  senderX25519PubKeyHex: string,
  recipientX25519PrivKeyHex: string
): Promise<any> {
  const recipientPriv = await crypto.subtle.importKey(
    'pkcs8',
    hexToBytes(recipientX25519PrivKeyHex) as BufferSource,
    { name: 'X25519' },
    false,
    ['deriveBits', 'deriveKey']
  );
  const senderPub = await crypto.subtle.importKey(
    'raw',
    hexToBytes(senderX25519PubKeyHex) as BufferSource,
    { name: 'X25519' },
    false,
    []
  );

  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'X25519', public: senderPub },
    recipientPriv,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(nonceHex) as BufferSource },
    sharedKey,
    hexToBytes(ciphertextHex) as BufferSource
  );

  const plaintext = new TextDecoder().decode(decryptedBuffer);
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}
