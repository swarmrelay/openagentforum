import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalizeJson, generateAgentKeyPair, importEdPrivateKey, bytesToHex,
  type AgentKeyPair,
} from '../src/crypto.js';
import {
  ROOM_CONTROL_PROTOCOL, ROOM_CONTROL_LIMITS, deriveRoomId, evaluateRoomControl,
  roomControlSignString, signRoomControl,
  type RoomControlAction, type RoomControlResult, type RoomState,
} from '../../../docs/rfc/fixtures/room-control-reference.js';

const hub = 'https://relay.example.com';
const now = 1_800_000_000_000;
const context = { hub, now };
let owner: AgentKeyPair;
let peer: AgentKeyPair;
let outsider: AgentKeyPair;
let nextRequest = 0;
beforeAll(async () => {
  [owner, peer, outsider] = await Promise.all([
    generateAgentKeyPair(), generateAgentKeyPair(), generateAgentKeyPair(),
  ]);
});

function common(actor: AgentKeyPair, roomId: string, expectedRevision: number) {
  return {
    protocol: ROOM_CONTROL_PROTOCOL, hub, roomId, actor: actor.agentId,
    requestId: (++nextRequest).toString(16).padStart(32, '0'),
    issuedAt: now, expiresAt: now + 60_000, expectedRevision,
  };
}
function success(result: RoomControlResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result;
}
async function evaluate(state: RoomState | null, action: RoomControlAction, actor = owner, at = now) {
  return evaluateRoomControl(state, await signRoomControl(action, actor.signingPrivateKey),
    actor.signingPublicKey, { hub, now: at });
}
async function create() {
  const base = common(owner, '', 0);
  base.roomId = await deriveRoomId(hub, owner.agentId, base.requestId);
  const action: RoomControlAction = { ...base, action: 'create', payload: {
    encryptionPublicKey: owner.encryptionPublicKey,
  } };
  const wire = await signRoomControl(action, owner.signingPrivateKey);
  const result = success(await evaluateRoomControl(null, wire, owner.signingPublicKey, context));
  return { action, wire, state: result.state };
}
function inviteAction(state: RoomState, recipient = peer): RoomControlAction {
  return { ...common(owner, state.roomId, state.revision), action: 'invite', payload: {
    recipient: recipient.agentId, recipientSigningPublicKey: recipient.signingPublicKey,
    inviteExpiresAt: now + 600_000,
  } };
}
async function invited() {
  const created = await create();
  const action = inviteAction(created.state);
  const result = success(await evaluate(created.state, action));
  return { ...created, invite: action, state: result.state, digest: result.proofDigest };
}
function acceptAction(state: RoomState, digest: string, actor = peer): RoomControlAction {
  return { ...common(actor, state.roomId, state.revision), action: 'accept', payload: {
    invitationDigest: digest, encryptionPublicKey: actor.encryptionPublicKey,
  } };
}
function closeAction(state: RoomState, actor = owner): RoomControlAction {
  return { ...common(actor, state.roomId, state.revision), action: 'close', payload: {} };
}
function change(wire: string, edit: (proof: Record<string, any>) => void) {
  const proof = JSON.parse(wire);
  edit(proof);
  return canonicalizeJson(proof);
}

describe('RFC 0003 unpublished room-control reference', () => {
  it('type-checks the unpublished reference in the existing CI test command', () => {
    const require = createRequire(import.meta.url);
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p',
      fileURLToPath(new URL('../../../docs/rfc/fixtures/tsconfig.json', import.meta.url))],
    { stdio: 'pipe' });
  }, 30_000);

  it('creates, invites, accepts and closes with immutable, identity-signed key bindings', async () => {
    const { state, digest } = await invited();
    expect(state.revision).toBe(2);
    const joined = success(await evaluate(state, acceptAction(state, digest), peer)).state;
    expect(joined.revision).toBe(3);
    expect(joined.owner).toEqual({ agentId: owner.agentId, signingPublicKey: owner.signingPublicKey,
      encryptionPublicKey: owner.encryptionPublicKey });
    expect(joined.peer).toEqual({ agentId: peer.agentId, signingPublicKey: peer.signingPublicKey,
      encryptionPublicKey: peer.encryptionPublicKey });
    expect(joined.invitation).toBeNull();
    const closed = success(await evaluate(joined, closeAction(joined, peer), peer)).state;
    expect(closed.status).toBe('closed');
    expect(closed.revision).toBe(4);
    expect(closed.owner).toEqual(joined.owner);
    expect(closed.peer).toEqual(joined.peer);
  });

  it('rejects a mismatched actor verification key', async () => {
    const { wire } = await create();
    expect(await evaluateRoomControl(null, wire, outsider.signingPublicKey, context))
      .toEqual({ ok: false, reason: 'identity_mismatch' });
  });

  it.each(['owner encryption key', 'room ID', 'request ID', 'revision', 'signature'])(
    'rejects tampering with %s', async (field) => {
      const { state } = await create();
      // An invite permits any non-negative revision syntactically; cryptographic verification must reject alteration.
      const original = field === 'owner encryption key' ? (await create()).wire
        : await signRoomControl(inviteAction(state), owner.signingPrivateKey);
      const wire = change(original, proof => {
        if (field === 'owner encryption key') proof.payload.encryptionPublicKey = outsider.encryptionPublicKey;
        if (field === 'room ID') proof.roomId = `room_${'f'.repeat(32)}`;
        if (field === 'request ID') proof.requestId = 'f'.repeat(32);
        if (field === 'revision') proof.expectedRevision += 1;
        if (field === 'signature') proof.signature = '0'.repeat(128);
      });
      expect(await evaluateRoomControl(state, wire, owner.signingPublicKey, context))
        .toEqual({ ok: false, reason: 'invalid_signature' });
    });

  it('rejects invitation recipient and acceptance key substitution', async () => {
    const { state, invite, digest } = await invited();
    const invitation = await signRoomControl(invite, owner.signingPrivateKey);
    const swapped = change(invitation, proof => {
      proof.payload.recipient = outsider.agentId;
      proof.payload.recipientSigningPublicKey = outsider.signingPublicKey;
    });
    expect(await evaluateRoomControl(state, swapped, owner.signingPublicKey, context))
      .toEqual({ ok: false, reason: 'invalid_signature' });
    const acceptance = await signRoomControl(acceptAction(state, digest), peer.signingPrivateKey);
    expect(await evaluateRoomControl(state, change(acceptance, proof => {
      proof.payload.encryptionPublicKey = outsider.encryptionPublicKey;
    }), peer.signingPublicKey, context)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects signatures from a different application domain', async () => {
    const { action } = await create();
    const key = await importEdPrivateKey(owner.signingPrivateKey);
    const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', key,
      new TextEncoder().encode(`another-protocol\n${canonicalizeJson(action)}`))));
    expect(await evaluateRoomControl(null, canonicalizeJson({ ...action, signature }),
      owner.signingPublicKey, context)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('binds the hub and prevents choosing an existing room alias', async () => {
    const { action, wire, state } = await create();
    expect(await evaluateRoomControl(null, wire, owner.signingPublicKey,
      { hub: 'https://other.example.com', now })).toEqual({ ok: false, reason: 'wrong_hub' });
    expect(await evaluate(null, { ...action, roomId: `room_${'f'.repeat(32)}` }))
      .toEqual({ ok: false, reason: 'wrong_room' });
    const different = await create();
    expect(await evaluate(state, inviteAction(different.state)))
      .toEqual({ ok: false, reason: 'wrong_room' });
    expect(await evaluateRoomControl({ ...state, hub: 'https://other.example.com' },
      wire, owner.signingPublicKey, context)).toEqual({ ok: false, reason: 'wrong_room' });
  });

  it('requires canonical wire, including no duplicate properties or numeric aliases', async () => {
    const { wire } = await create();
    for (const raw of [
      ` ${wire}`, `${wire}\n`, JSON.stringify(JSON.parse(wire), null, 2),
      wire.replace('{', '{"action":"create",'),
      wire.replace('"expectedRevision":0', '"expectedRevision":-0'),
      wire.replace('"issuedAt":1800000000000', '"issuedAt":1.8e12'),
      JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(wire)).reverse())),
    ]) {
      expect((await evaluateRoomControl(null, raw, owner.signingPublicKey, context)).ok).toBe(false);
    }
  });

  it.each([
    ['unknown outer field', (p: any) => { p.extra = true; }],
    ['unknown payload field', (p: any) => { p.payload.allowedAgents = []; }],
    ['unknown action', (p: any) => { p.action = 'rotate'; }],
    ['unknown version', (p: any) => { p.protocol = 'oaf-room-control-v2'; }],
    ['fractional time', (p: any) => { p.issuedAt += 0.5; }],
    ['unsafe revision', (p: any) => { p.expectedRevision = Number.MAX_SAFE_INTEGER + 1; }],
    ['uppercase hex', (p: any) => { p.payload.encryptionPublicKey = 'A'.repeat(64); }],
    ['short encryption key', (p: any) => { p.payload.encryptionPublicKey = 'ab'; }],
    ['nested payload', (p: any) => { p.payload.encryptionPublicKey = {}; }],
    ['null payload', (p: any) => { p.payload = null; }],
    ['array payload', (p: any) => { p.payload = []; }],
    ['long proof lifetime', (p: any) => { p.expiresAt = p.issuedAt + 300_001; }],
    ['empty proof lifetime', (p: any) => { p.expiresAt = p.issuedAt; }],
    ['HTTP origin', (p: any) => { p.hub = 'http://relay.example.com'; }],
    ['origin path', (p: any) => { p.hub += '/'; }],
    ['origin credentials', (p: any) => { p.hub = 'https://agent@relay.example.com'; }],
  ])('rejects malformed schema: %s', async (_name, edit) => {
    const { wire } = await create();
    expect(await evaluateRoomControl(null, change(wire, edit), owner.signingPublicKey, context))
      .toEqual({ ok: false, reason: 'invalid_schema' });
  });

  it('bounds parsing and rejects malformed verification context and keys', async () => {
    const { wire } = await create();
    for (const raw of ['{', ' '.repeat(4097), 'é'.repeat(2049)]) {
      expect(await evaluateRoomControl(null, raw, owner.signingPublicKey, context))
        .toEqual({ ok: false, reason: 'invalid_wire' });
    }
    expect(await evaluateRoomControl(null, wire, owner.signingPublicKey, { hub, now: NaN }))
      .toEqual({ ok: false, reason: 'invalid_context' });
    expect(await evaluateRoomControl(null, wire, owner.signingPublicKey, { hub: `${hub}/`, now }))
      .toEqual({ ok: false, reason: 'invalid_context' });
    expect(await evaluateRoomControl(null, wire, 'xyz', context))
      .toEqual({ ok: false, reason: 'invalid_public_key' });
  });

  it('enforces inclusive expiry and the future-skew boundary', async () => {
    const { action } = await create();
    expect((await evaluate(null, action, owner, action.expiresAt - 1)).ok).toBe(true);
    expect(await evaluate(null, action, owner, action.expiresAt))
      .toEqual({ ok: false, reason: 'expired_proof' });
    expect((await evaluate(null, action, owner, now - ROOM_CONTROL_LIMITS.futureSkewMs)).ok).toBe(true);
    expect(await evaluate(null, action, owner, now - ROOM_CONTROL_LIMITS.futureSkewMs - 1))
      .toEqual({ ok: false, reason: 'future_proof' });
  });

  it('accepts the exact maximum proof and invitation lifetimes', async () => {
    const { action } = await create();
    action.expiresAt = now + ROOM_CONTROL_LIMITS.proofLifetimeMs;
    const state = success(await evaluate(null, action)).state;
    const invitation = inviteAction(state);
    if (invitation.action !== 'invite') throw new Error('Expected invite');
    invitation.payload.inviteExpiresAt = now + ROOM_CONTROL_LIMITS.invitationLifetimeMs;
    expect((await evaluate(state, invitation)).ok).toBe(true);
  });

  it('requires the owner to invite a different, correctly bound identity', async () => {
    const { state } = await create();
    expect(await evaluate(state, { ...inviteAction(state), actor: outsider.agentId }, outsider))
      .toEqual({ ok: false, reason: 'not_authorized' });
    expect(await evaluate(state, inviteAction(state, owner)))
      .toEqual({ ok: false, reason: 'invalid_recipient' });
    const action = inviteAction(state);
    if (action.action !== 'invite') throw new Error('Expected invite');
    action.payload.recipientSigningPublicKey = outsider.signingPublicKey;
    expect(await evaluate(state, action)).toEqual({ ok: false, reason: 'invalid_recipient' });
  });

  it('rejects accept/close by an unaccepted or wrong recipient', async () => {
    const { state, digest } = await invited();
    expect(await evaluate(state, acceptAction(state, digest, outsider), outsider))
      .toEqual({ ok: false, reason: 'not_authorized' });
    expect(await evaluate(state, closeAction(state, peer), peer))
      .toEqual({ ok: false, reason: 'not_authorized' });
    expect(await evaluate(state, acceptAction(state, 'f'.repeat(64)), peer))
      .toEqual({ ok: false, reason: 'invitation_mismatch' });
    // Even an inconsistent trusted directory key cannot replace the admitted full-key binding.
    const substituted = structuredClone(state);
    substituted.invitation!.recipientSigningPublicKey = outsider.signingPublicKey;
    expect(await evaluate(substituted, acceptAction(state, digest), peer))
      .toEqual({ ok: false, reason: 'not_authorized' });
  });

  it('replacing an invitation invalidates the old digest even with a fresh revision', async () => {
    const { state, digest } = await invited();
    const replacement = success(await evaluate(state, inviteAction(state))).state;
    expect(replacement.revision).toBe(3);
    expect(await evaluate(replacement, acceptAction(replacement, digest), peer))
      .toEqual({ ok: false, reason: 'invitation_mismatch' });
    expect((await evaluate(replacement, acceptAction(replacement, replacement.invitation!.digest), peer)).ok)
      .toBe(true);
  });

  it('persists invitation validity separately from the admitted proof lifetime', async () => {
    const { state, digest } = await invited();
    const action = acceptAction(state, digest);
    action.issuedAt = now + 600_000 - 1;
    action.expiresAt = action.issuedAt + 60_000;
    expect((await evaluate(state, action, peer, now + 600_000 - 1)).ok).toBe(true);
    expect(await evaluate(state, action, peer, now + 600_000))
      .toEqual({ ok: false, reason: 'invitation_expired' });
    const { state: empty } = await create();
    const invitation = inviteAction(empty);
    if (invitation.action !== 'invite') throw new Error('Expected invite');
    invitation.payload.inviteExpiresAt = now + 1;
    expect(await evaluate(empty, invitation, owner, now + 1))
      .toEqual({ ok: false, reason: 'invitation_expired' });
  });

  it('rejects overlong invitation lifetime before verification', async () => {
    const { state } = await create();
    const wire = await signRoomControl(inviteAction(state), owner.signingPrivateKey);
    expect(await evaluateRoomControl(state, change(wire, proof => {
      proof.payload.inviteExpiresAt = now + ROOM_CONTROL_LIMITS.invitationLifetimeMs + 1;
    }), owner.signingPublicKey, context)).toEqual({ ok: false, reason: 'invalid_schema' });
  });

  it('limits membership to two and has no implicit key update operation', async () => {
    const { state, digest } = await invited();
    const joined = success(await evaluate(state, acceptAction(state, digest), peer)).state;
    expect(await evaluate(joined, inviteAction(joined, outsider)))
      .toEqual({ ok: false, reason: 'room_full' });
    expect(await evaluate(joined, closeAction(joined, outsider), outsider))
      .toEqual({ ok: false, reason: 'not_authorized' });
    expect(await evaluate(joined, acceptAction(joined, digest), peer))
      .toEqual({ ok: false, reason: 'room_full' });
    const wire = await signRoomControl(closeAction(joined), owner.signingPrivateKey);
    expect(await evaluateRoomControl(joined, change(wire, proof => {
      proof.payload.encryptionPublicKey = outsider.encryptionPublicKey;
    }), owner.signingPublicKey, context)).toEqual({ ok: false, reason: 'invalid_schema' });
  });

  it('keeps closure terminal and rejects a replayed creation while the tombstone is retained', async () => {
    const { state, action, wire, digest } = await invited();
    const closed = success(await evaluate(state, closeAction(state))).state;
    expect(closed.invitation).toBeNull();
    expect(await evaluate(closed, acceptAction(closed, digest), peer))
      .toEqual({ ok: false, reason: 'room_closed' });
    expect(await evaluate(closed, inviteAction(closed)))
      .toEqual({ ok: false, reason: 'room_closed' });
    expect(await evaluate(closed, closeAction(closed)))
      .toEqual({ ok: false, reason: 'room_closed' });
    expect(await evaluateRoomControl(closed, wire, owner.signingPublicKey, context))
      .toEqual({ ok: false, reason: 'room_exists' });
    expect(await evaluate(closed, action)).toEqual({ ok: false, reason: 'room_exists' });
  });

  it('rejects missing state, stale proofs and revision overflow', async () => {
    const { state } = await create();
    const action = inviteAction(state);
    expect(await evaluate(null, action)).toEqual({ ok: false, reason: 'room_missing' });
    const invitedState = success(await evaluate(state, action)).state;
    expect(await evaluate(invitedState, action)).toEqual({ ok: false, reason: 'revision_conflict' });
    const saturated = { ...state, revision: Number.MAX_SAFE_INTEGER };
    expect(await evaluate(saturated, closeAction(saturated)))
      .toEqual({ ok: false, reason: 'revision_conflict' });
  });

  it('does not mutate inputs and snapshots before asynchronous verification/signing', async () => {
    const { state } = await create();
    const original = structuredClone(state);
    const action = inviteAction(state);
    const signing = signRoomControl(action, owner.signingPrivateKey);
    action.roomId = `room_${'f'.repeat(32)}`;
    const wire = await signing;
    expect(JSON.parse(wire).roomId).toBe(original.roomId);
    const evaluating = evaluateRoomControl(state, wire, owner.signingPublicKey, context);
    state.status = 'closed';
    const result = success(await evaluating);
    expect(result.state.status).toBe('open');
    expect(result.state.owner).toEqual(original.owner);
    expect(state.invitation).toBeNull();
    result.state.owner.encryptionPublicKey = '0'.repeat(64);
    expect(state.owner).toEqual(original.owner);
  });

  it('refuses to sign an action carrying an extra signature property', async () => {
    const { action } = await create();
    await expect(signRoomControl({ ...action, signature: '0'.repeat(128) } as RoomControlAction,
      owner.signingPrivateKey)).rejects.toThrow('Invalid room action');
  });

  it('models why two valid proposals at one revision require an atomic commit CAS', async () => {
    const { state } = await create();
    const first = inviteAction(state, peer);
    const second = inviteAction(state, outsider);
    const proposals = await Promise.all([evaluate(state, first), evaluate(state, second)]);
    let committed = state;
    // Test-only synchronous CAS, NOT a durable adapter, transaction or idempotency store.
    const commit = (proposal: RoomControlResult) => {
      const result = success(proposal);
      if (committed.revision !== state.revision) return false;
      committed = result.state;
      return true;
    };
    expect(proposals.map(commit)).toEqual([true, false]);
    expect(committed.invitation?.recipient).toBe(peer.agentId);
  });
});

describe('fixed public room-control conformance vectors', () => {
  it('verifies all action bytes, digests, signatures and state transitions independently', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/room-control-v1.json', import.meta.url), 'utf8'));
    let state: RoomState | null = null;
    expect(fixture.vectors.map((vector: any) => vector.action.action)).toEqual(['create', 'invite', 'accept', 'close']);
    for (const vector of fixture.vectors) {
      const signString = roomControlSignString(vector.action);
      expect(signString).toBe(vector.signString);
      expect(Buffer.from(signString, 'utf8').toString('hex')).toBe(vector.signBytesHex);
      expect(createHash('sha256').update(signString, 'utf8').digest('hex')).toBe(vector.proofDigest);
      const proof = JSON.parse(vector.wire);
      expect(canonicalizeJson({ ...vector.action, signature: proof.signature })).toBe(vector.wire);
      const publicKey = createPublicKey({ key: {
        kty: 'OKP', crv: 'Ed25519', x: Buffer.from(vector.publicKey, 'hex').toString('base64url'),
      }, format: 'jwk' });
      expect(verify(null, Buffer.from(signString, 'utf8'), publicKey, Buffer.from(proof.signature, 'hex'))).toBe(true);
      const result = success(await evaluateRoomControl(state, vector.wire, vector.publicKey,
        { hub: fixture.hub, now: fixture.now }));
      expect(result.proofDigest).toBe(vector.proofDigest);
      expect(result.state).toEqual(vector.expectedState);
      state = result.state;
    }
  });
});
