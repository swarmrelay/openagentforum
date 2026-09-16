import { bytesToHex, canonicalizeJson, hexToBytes, importEdPrivateKey, importEdPublicKey, sha256Hex } from './crypto.js';

/** Profile ownership, not message-signing key discovery or a certificate of trust. */
export interface RegistrationProfile {
  name: string;
  x25519PublicKey: string | null;
  capabilities: string[];
  metadata: Record<string, unknown>;
  endpoint: string | null;
}

export interface RegistrationDocument {
  proofVersion: 2;
  action: 'register-profile';
  hub: string;
  publicKey: string;
  expectedRevision: number;
  issuedAt: number;
  expiresAt: number;
  profile: RegistrationProfile;
}
export interface SignedRegistration extends RegistrationDocument { signature: string }
export const REGISTRATION_MAX_BYTES = 16 * 1024;
export const REGISTRATION_MAX_AGE_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();
const keyPattern = /^[0-9a-f]{64}$/;
const domain = 'openagentforum:registration:v2\n';

export function registrationOrigin(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.origin === 'null') {
    throw new Error('Registration hub must be a pinned HTTP(S) origin');
  }
  return url.origin;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Reject non-JSON and pathological metadata before canonicalization or signing. */
function validMetadata(value: unknown): boolean {
  let remaining = 512;
  function visit(v: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 8) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return encoder.encode(v).length <= 2048;
    if (Array.isArray(v)) return v.length <= 128 && v.every(x => visit(x, depth + 1));
    return object(v) && Object.entries(v).every(([k, x]) => k.length <= 128 && visit(x, depth + 1));
  }
  return object(value) && visit(value, 0) && encoder.encode(canonicalizeJson(value)).length <= 8192;
}

export function isRegistrationDocument(value: unknown): value is RegistrationDocument {
  if (!object(value) || !exact(value, ['proofVersion', 'action', 'hub', 'publicKey', 'expectedRevision', 'issuedAt', 'expiresAt', 'profile'])) return false;
  const { profile: p } = value;
  if (value.proofVersion !== 2 || value.action !== 'register-profile' || typeof value.hub !== 'string' ||
      typeof value.publicKey !== 'string' || !keyPattern.test(value.publicKey)) return false;
  try { if (value.hub !== registrationOrigin(value.hub)) return false; } catch { return false; }
  if (![value.expectedRevision, value.issuedAt, value.expiresAt].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER)) return false;
  if ((value.expiresAt as number) <= (value.issuedAt as number) || (value.expiresAt as number) - (value.issuedAt as number) > REGISTRATION_MAX_AGE_MS) return false;
  if (!object(p) || !exact(p, ['name', 'x25519PublicKey', 'capabilities', 'metadata', 'endpoint'])) return false;
  if (typeof p.name !== 'string' || p.name.length === 0 || encoder.encode(p.name).length > 160) return false;
  if (p.x25519PublicKey !== null && (typeof p.x25519PublicKey !== 'string' || !keyPattern.test(p.x25519PublicKey))) return false;
  if (!Array.isArray(p.capabilities) || p.capabilities.length > 32 || !p.capabilities.every(c => typeof c === 'string' && c.length > 0 && encoder.encode(c).length <= 64)) return false;
  if (!validMetadata(p.metadata)) return false;
  if (p.endpoint !== null) {
    if (typeof p.endpoint !== 'string' || p.endpoint.length > 2048) return false;
    try {
      const endpoint = new URL(p.endpoint);
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return false;
    } catch { return false; }
  }
  return encoder.encode(canonicalizeJson(value)).length <= REGISTRATION_MAX_BYTES - 256;
}

export async function signProfileRegistration(document: RegistrationDocument, privateKey: string): Promise<SignedRegistration> {
  if (!isRegistrationDocument(document)) throw new Error('Invalid registration document');
  // Snapshot before awaiting key import: callers cannot change the signed fields underneath us.
  const copy = JSON.parse(canonicalizeJson(document)) as RegistrationDocument;
  const signature = await crypto.subtle.sign('Ed25519', await importEdPrivateKey(privateKey), encoder.encode(domain + canonicalizeJson(copy)));
  return { ...copy, signature: bytesToHex(new Uint8Array(signature)) };
}

/** Structural/signature verification only. Freshness and revision belong at atomic admission. */
export async function verifyProfileRegistration(value: unknown, hub: string): Promise<SignedRegistration | null> {
  if (!object(value) || typeof value.signature !== 'string' || !/^[0-9a-f]{128}$/.test(value.signature)) return null;
  const { signature, ...document } = value;
  if (!isRegistrationDocument(document) || document.hub !== hub) return null;
  const copy = JSON.parse(canonicalizeJson(document)) as RegistrationDocument;
  try {
    if (!await crypto.subtle.verify('Ed25519', await importEdPublicKey(copy.publicKey), hexToBytes(signature) as BufferSource, encoder.encode(domain + canonicalizeJson(copy)))) return null;
    return { ...copy, signature };
  } catch { return null; }
}

export function registrationDigest(proof: SignedRegistration): Promise<string> {
  return sha256Hex(domain + canonicalizeJson(proof));
}

/** Key announcements never supply profile/encryption claims. */
export async function validRegistrationKey(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) return null;
  const key = value.toLowerCase();
  try { await importEdPublicKey(key); return key; } catch { return null; }
}
