/**
 * RFC 6962 Merkle tree over already-hashed leaves. Domain separated:
 * leaf = sha256(0x00 || data), node = sha256(0x01 || left || right).
 * Unbalanced construction (largest power of two on the left), no
 * duplication of odd nodes, so a root together with its leaf count pins
 * exactly one tree shape and inclusion proofs are unambiguous.
 */
import { bytesToHex, hexToBytes } from './crypto.js';

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Hash a leaf's raw bytes with the 0x00 prefix. */
export async function merkleLeafHash(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return sha256(concat(new Uint8Array([0x00]), bytes));
}

async function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(new Uint8Array([0x01]), left, right));
}

/** largest power of two strictly less than n (n >= 2) */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Merkle tree hash over leaf hashes (RFC 6962 section 2.1). */
export async function merkleRoot(leafHashes: Uint8Array[]): Promise<Uint8Array> {
  const n = leafHashes.length;
  if (n === 0) return sha256(new Uint8Array(0));
  if (n === 1) return leafHashes[0];
  const k = split(n);
  const [l, r] = await Promise.all([merkleRoot(leafHashes.slice(0, k)), merkleRoot(leafHashes.slice(k))]);
  return nodeHash(l, r);
}

/** Audit path for leaf m in a tree of the given leaves (RFC 6962 section 2.1.1). */
export async function merkleAuditPath(m: number, leafHashes: Uint8Array[]): Promise<Uint8Array[]> {
  const n = leafHashes.length;
  if (n <= 1) return [];
  const k = split(n);
  if (m < k) {
    const path = await merkleAuditPath(m, leafHashes.slice(0, k));
    path.push(await merkleRoot(leafHashes.slice(k)));
    return path;
  }
  const path = await merkleAuditPath(m - k, leafHashes.slice(k));
  path.push(await merkleRoot(leafHashes.slice(0, k)));
  return path;
}

export interface MerkleProof {
  leafIndex: number;
  leafCount: number;
  /** sibling hashes from the leaf upward, hex */
  path: string[];
}

export async function merkleProof(leafIndex: number, leafHashes: Uint8Array[]): Promise<MerkleProof> {
  if (leafIndex < 0 || leafIndex >= leafHashes.length) throw new Error('leafIndex out of range');
  const path = await merkleAuditPath(leafIndex, leafHashes);
  return { leafIndex, leafCount: leafHashes.length, path: path.map(bytesToHex) };
}

/** Recompute the root from a leaf hash and its audit path (RFC 6962 section 2.1.1 inverse). */
export async function verifyMerkleProof(leafHash: Uint8Array, proof: MerkleProof, rootHex: string): Promise<boolean> {
  let idx = proof.leafIndex;
  let size = proof.leafCount;
  let hash = leafHash;
  if (size === 0 || idx >= size) return false;
  const path = proof.path.map(hexToBytes);
  // walk the same recursion as merkleAuditPath, deciding left/right by subtree geometry
  const steps: Array<'left' | 'right'> = [];
  const walk = (m: number, n: number) => {
    if (n <= 1) return;
    const k = split(n);
    if (m < k) { walk(m, k); steps.push('right'); } else { walk(m - k, n - k); steps.push('left'); }
  };
  walk(idx, size);
  if (steps.length !== path.length) return false;
  for (let i = 0; i < path.length; i++) {
    hash = steps[i] === 'right' ? await nodeHash(hash, path[i]) : await nodeHash(path[i], hash);
  }
  return bytesToHex(hash) === rootHex.toLowerCase();
}
