import { beforeAll, describe, expect, it } from 'vitest';
import { createPrivateKey } from 'node:crypto';
import { privateKeyFromRaw } from '@libp2p/crypto/keys';
import { defaultCrypto } from '@chainsafe/libp2p-noise/crypto';
import * as protocol from '@openagentforum/protocol';

// Exercise the installed handshake implementation, not a second implementation
// of its signature format. These internal imports deliberately make upgrades a
// review point; they are test-only and never part of the client API.
const noiseEntry = import.meta.resolve('@chainsafe/libp2p-noise');
const { getSignaturePayload, createHandshakePayload, decodeHandshakePayload } =
  await import(new URL('./utils.js', noiseEntry).href);
const { NoiseHandshakePayload } = await import(new URL('./proto/payload.js', noiseEntry).href);
const noisePrefix = 'noise-libp2p-static-key:';
const encode = (value: string) => new TextEncoder().encode(value);

let identity: protocol.AgentKeyPair;
let noiseKey: ReturnType<typeof privateKeyFromRaw>;
let staticKey: Uint8Array;
let noiseBytes: Uint8Array;
let noiseProof: { identityKey: Uint8Array; identitySig: Uint8Array };
let noiseSignature: string;

beforeAll(async () => {
  identity = await protocol.generateAgentKeyPair();
  const jwk = createPrivateKey({ key: Buffer.from(identity.signingPrivateKey, 'hex'), type: 'pkcs8', format: 'der' })
    .export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d!, 'base64url');
  const raw = Buffer.concat([seed, Buffer.from(identity.signingPublicKey, 'hex')]);
  try { noiseKey = privateKeyFromRaw(raw); } finally { seed.fill(0); raw.fill(0); }
  const staticPair = defaultCrypto.generateX25519KeyPair();
  staticKey = staticPair.publicKey;
  staticPair.privateKey.fill(0);
  noiseBytes = getSignaturePayload(staticKey);
  const payload = await createHandshakePayload(noiseKey, staticKey);
  noiseProof = await decodeHandshakePayload(payload, staticKey, noiseKey.publicKey);
  noiseSignature = protocol.bytesToHex(noiseProof.identitySig);
});

async function separated(signString: string, signature: string) {
  const oafBytes = encode(signString);
  // Same key, working positive controls: rejection must not be due to a wrong
  // identity, malformed signature, failed setup or a mocked verification path.
  expect(await noiseKey.publicKey.verify(oafBytes, protocol.hexToBytes(signature))).toBe(true);
  expect(await noiseKey.publicKey.verify(noiseBytes, noiseProof.identitySig)).toBe(true);
  expect(await noiseKey.publicKey.verify(oafBytes, noiseProof.identitySig)).toBe(false);
  const transplanted = NoiseHandshakePayload.encode({ ...noiseProof, identitySig: protocol.hexToBytes(signature) });
  await expect(decodeHandshakePayload(transplanted, staticKey, noiseKey.publicKey)).rejects.toThrow('Invalid payload signature');
}

describe('OAF identity / Noise signing boundary (#278)', () => {
  it('pins the actual Noise signature input to its domain plus one 32-byte static key', () => {
    expect(noiseKey.publicKey.raw).toEqual(protocol.hexToBytes(identity.signingPublicKey));
    expect(staticKey.byteLength).toBe(32);
    expect(noiseBytes).toEqual(new Uint8Array([...encode(noisePrefix), ...staticKey]));
    expect(encode(noisePrefix).byteLength).toBe(24);
    expect(noiseBytes.byteLength).toBe(56);
  });

  it('requires explicit review when the protocol exports a new signing helper', () => {
    expect(Object.entries(protocol).filter(([name, value]) => name.startsWith('sign') && typeof value === 'function')
      .map(([name]) => name).sort()).toEqual([
        'signEnvelope', 'signHookAction', 'signProfileRegistration', 'signRegistrationProof', 'signTaskAction',
      ]);
  });

  for (const id of [undefined, noisePrefix, noisePrefix + 'a'.repeat(32), 'register|task|hook|', '\0|\nλ']) {
    it(`keeps v1 envelope signatures separate with caller-selected ID ${JSON.stringify(id)}`, async () => {
      const envelope = await protocol.signEnvelope({ id, channel: 'signature-fixture', sender: identity.agentId,
        type: 'intel', sequence: 0, timestamp: 0, payload: { message: 'local fixture' } }, identity.signingPrivateKey);
      const signString = protocol.getEnvelopeSignString(envelope);
      // v1 has no fixed prefix. Its computed 64-byte ASCII checksum suffix
      // alone exceeds the entire 56-byte Noise signature input, even if the
      // caller makes the ID begin with the Noise domain. Do not change v1 wire
      // bytes or mistake arbitrary raw-signing access for this bounded helper.
      expect(envelope.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(signString.endsWith('|' + envelope.checksum)).toBe(true);
      expect(encode(envelope.checksum).byteLength).toBeGreaterThan(noiseBytes.byteLength);
      if (id?.startsWith(noisePrefix)) expect(signString.startsWith(noisePrefix)).toBe(true);
      expect((await protocol.verifyEnvelope(envelope, identity.signingPublicKey)).valid).toBe(true);
      await separated(signString, envelope.signature);
      expect((await protocol.verifyEnvelope({ ...envelope, signature: noiseSignature }, identity.signingPublicKey)).valid).toBe(false);
    });
  }

  it('keeps the legacy registration proof separate (historical verification only)', async () => {
    const timestamp = Date.now();
    const signature = await protocol.signRegistrationProof(identity.agentId, timestamp, identity.signingPrivateKey);
    const signString = `register|${identity.agentId}|${timestamp}`;
    await separated(signString, signature);
    expect(await protocol.verifyRegistrationProof(identity.agentId, timestamp, identity.signingPublicKey, signature)).toBe(true);
    expect(await protocol.verifyRegistrationProof(identity.agentId, timestamp, identity.signingPublicKey, noiseSignature)).toBe(false);
  });

  it('keeps the fixed registration-v2 domain separate', async () => {
    const issuedAt = Date.now();
    const document: protocol.RegistrationDocument = { proofVersion: 2, action: 'register-profile',
      hub: 'http://127.0.0.1:9876', publicKey: identity.signingPublicKey, expectedRevision: 0,
      issuedAt, expiresAt: issuedAt + 60_000,
      profile: { name: 'SignatureFixture', x25519PublicKey: null, capabilities: [], metadata: {}, endpoint: null } };
    const proof = await protocol.signProfileRegistration(document, identity.signingPrivateKey);
    await separated('openagentforum:registration:v2\n' + protocol.canonicalizeJson(document), proof.signature);
    expect(await protocol.verifyProfileRegistration(proof, document.hub)).not.toBeNull();
    expect(await protocol.verifyProfileRegistration({ ...proof, signature: noiseSignature }, document.hub)).toBeNull();
  });

  for (const action of ['create', 'claim', 'submit'] as const) {
    it(`keeps the fixed task ${action} domain separate`, async () => {
      const params = { action, taskId: action === 'create' ? '-' : 'fixture-task', agentId: identity.agentId,
        timestamp: Date.now(), payload: {} };
      const signature = await protocol.signTaskAction(params, identity.signingPrivateKey);
      const signString = await protocol.taskActionString(params);
      expect(signString.startsWith(`task|${action}|`)).toBe(true);
      await separated(signString, signature);
      expect((await protocol.verifyTaskAction({ ...params, signature }, identity.signingPublicKey)).valid).toBe(true);
      expect((await protocol.verifyTaskAction({ ...params, signature: noiseSignature }, identity.signingPublicKey)).valid).toBe(false);
    });
  }

  for (const action of ['set', 'delete', 'renew', 'list'] as const) {
    it(`keeps the fixed hook ${action} domain separate`, async () => {
      const hook = { url: 'https://receiver.example.net/hint', channels: ['general'], secret: 'fixture-only-'.repeat(4) };
      const params = { action, agentId: identity.agentId, hookId: await protocol.deriveHookId(identity.agentId, hook.url),
        timestamp: Date.now(), hook };
      const signature = await protocol.signHookAction(params, identity.signingPrivateKey);
      const signString = await protocol.hookSignString(params);
      expect(signString.startsWith(`hook|${action}|`)).toBe(true);
      await separated(signString, signature);
      expect((await protocol.verifyHookAction({ ...params, signature }, identity.signingPublicKey)).valid).toBe(true);
      expect((await protocol.verifyHookAction({ ...params, signature: noiseSignature }, identity.signingPublicKey)).valid).toBe(false);
    });
  }
});
