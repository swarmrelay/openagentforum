import { describe, it, expect } from 'vitest';
import { merkleRoot, merkleLeafHash, merkleProof, verifyMerkleProof, bytesToHex, sha256Hex } from '../src/index.js';

/**
 * Independent reference implementation, transcribed from RFC 6962 section 2.1 rather
 * than from src/merkle.ts, so a mistake in one is not silently mirrored in the other.
 *   MTH({})      = SHA-256()
 *   MTH({d(0)})  = SHA-256(0x00 || d(0))
 *   MTH(D[n])    = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n])), k = largest power of two < n
 */
async function refLeafHash(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`\u0000${data}`)));
}
async function refRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return sha256Hex('');
  if (leaves.length === 1) return bytesToHex(await refLeafHash(leaves[0]));
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  const [left, right] = [await refRoot(leaves.slice(0, k)), await refRoot(leaves.slice(k))];
  const buffer = new Uint8Array(1 + left.length / 2 + right.length / 2);
  buffer[0] = 0x01;
  buffer.set(new Uint8Array(left.match(/../g)!.map((b) => parseInt(b, 16))), 1);
  buffer.set(new Uint8Array(right.match(/../g)!.map((b) => parseInt(b, 16))), 1 + left.length / 2);
  return sha256Hex(buffer);
}

const leaves = (n: number) => Array.from({ length: n }, (_, i) => `leaf-${i}`);
const hashes = (n: number) => Promise.all(leaves(n).map((l) => merkleLeafHash(l)));

describe('merkleRoot', () => {
  it('matches the RFC 6962 definition for empty, single and small trees', async () => {
    expect(bytesToHex(await merkleRoot([]))).toBe(await sha256Hex(''));
    const one = await merkleLeafHash('a');
    expect(bytesToHex(await merkleRoot([one]))).toBe(bytesToHex(one));
    for (const n of [2, 3, 4, 5, 7, 8, 9, 16, 17]) {
      expect(bytesToHex(await merkleRoot(await hashes(n)))).toBe(await refRoot(leaves(n)));
    }
  });

  it('does not duplicate an odd trailing node, so roots are not the balanced-tree roots', async () => {
    // A duplicating implementation would give MTH([a,b,c]) === MTH([a,b,c,c]).
    const three = bytesToHex(await merkleRoot(await hashes(3)));
    const four = bytesToHex(await merkleRoot(await hashes(4)));
    expect(three).not.toBe(four);
  });

  it('is order sensitive', async () => {
    const [a, b] = await hashes(2);
    expect(bytesToHex(await merkleRoot([a, b]))).not.toBe(bytesToHex(await merkleRoot([b, a])));
  });
});

describe('merkleProof / verifyMerkleProof', () => {
  it('verifies every leaf of every tree size from 1 to 33', async () => {
    for (let n = 1; n <= 33; n++) {
      const set = await hashes(n);
      const root = bytesToHex(await merkleRoot(set));
      for (let i = 0; i < n; i++) {
        const proof = await merkleProof(i, set);
        expect(proof).toMatchObject({ leafIndex: i, leafCount: n });
        expect(await verifyMerkleProof(set[i], proof, root)).toBe(true);
      }
    }
  });

  it('rejects a proof presented for a different leaf', async () => {
    const set = await hashes(6);
    const root = bytesToHex(await merkleRoot(set));
    const proof = await merkleProof(2, set);
    expect(await verifyMerkleProof(set[3], proof, root)).toBe(false);
  });

  it('rejects every single-bit tampering of a sibling', async () => {
    const set = await hashes(5);
    const root = bytesToHex(await merkleRoot(set));
    const proof = await merkleProof(4, set);
    for (let i = 0; i < proof.path.length; i++) {
      for (const replacement of ['0', '1']) {
        if (proof.path[i][0] === replacement) continue;
        const path = [...proof.path];
        path[i] = replacement + path[i].slice(1);
        expect(await verifyMerkleProof(set[4], { ...proof, path }, root)).toBe(false);
      }
    }
  });

  it('rejects a proof against the wrong root', async () => {
    const set = await hashes(4);
    const other = bytesToHex(await merkleRoot(await hashes(5)));
    const proof = await merkleProof(0, set);
    expect(await verifyMerkleProof(set[0], proof, other)).toBe(false);
  });

  it('accepts upper-case and 0x-prefixed sibling hex, which hexToBytes already parses', async () => {
    const set = await hashes(3);
    const root = bytesToHex(await merkleRoot(set));
    const proof = await merkleProof(0, set);
    expect(await verifyMerkleProof(set[0], { ...proof, path: proof.path.map((p) => p.toUpperCase()) }, root)).toBe(true);
    expect(await verifyMerkleProof(set[0], { ...proof, path: proof.path.map((p) => `0x${p}`) }, root)).toBe(true);
  });

  it('returns false, and does no hashing, for structurally invalid proofs', async () => {
    const set = await hashes(3);
    const root = bytesToHex(await merkleRoot(set));
    const proof = await merkleProof(1, set);
    const bad: Array<[string, unknown]> = [
      ['leafCount 0', { ...proof, leafCount: 0 }],
      ['leafIndex beyond size', { ...proof, leafIndex: 3 }],
      ['negative leafIndex', { ...proof, leafIndex: -1 }],
      ['fractional leafIndex', { ...proof, leafIndex: 0.5 }],
      ['non-numeric leafIndex', { ...proof, leafIndex: '1' }],
      ['NaN leafCount', { ...proof, leafCount: Number.NaN }],
      ['path not an array', { ...proof, path: 'deadbeef' }],
      ['path too long for any tree', { ...proof, path: Array(65).fill(proof.path[0]) }],
      ['sibling of the wrong length', { ...proof, path: [proof.path[0].slice(0, 62)] }],
      ['sibling with non-hex digits', { ...proof, path: ['z'.repeat(64)] }],
      ['sibling that is not a string', { ...proof, path: [null] }],
    ];
    for (const [label, candidate] of bad) {
      expect(await verifyMerkleProof(set[1], candidate as any, root), label).toBe(false);
    }
  });

  it('rejects an over-long path without decoding any sibling', async () => {
    const set = await hashes(3);
    const root = bytesToHex(await merkleRoot(set));
    const proof = await merkleProof(1, set);
    // A path of 1e6 valid-looking siblings must be refused on length alone, before
    // hexToBytes allocates for each entry.
    const huge = { ...proof, path: Array(1_000_000).fill(proof.path[0]) };
    const started = Date.now();
    expect(await verifyMerkleProof(set[1], huge, root)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('merkleProof input validation', () => {
  it('throws for an out-of-range leaf index', async () => {
    const set = await hashes(3);
    await expect(merkleProof(-1, set)).rejects.toThrow('leafIndex out of range');
    await expect(merkleProof(3, set)).rejects.toThrow('leafIndex out of range');
  });
});
