// RFC 0007 executable specification ONLY. No storage, HTTP adapter or publication.
// State arguments model a trusted atomic snapshot; never use this as a server.
import { canonicalizeJson, sha256Hex, bytesToHex, hexToBytes, importEdPrivateKey, importEdPublicKey }
  from '../../../packages/protocol/dist/index.js';

export const PROFILE = 'oaf-task-lease-v1';
export const LIMITS = Object.freeze({ minLeaseMs: 60_000, maxLeaseMs: 86_400_000,
  defaultLeaseMs: 3_600_000, proofMs: 300_000, futureSkewMs: 30_000,
  wireBytes: 32_768, resultBytes: 16_384, receipts: 128 });
const verified = new WeakMap();
const fail = code => { throw new Error(code); };
const requireThat = (condition, code = 'invalid') => { if (!condition) fail(code); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const bytes = value => new TextEncoder().encode(value).byteLength;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  requireThat(object(value));
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  requireThat(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]));
};
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function boundedJson(value, depth = 0, budget = { remaining: 1024 }) {
  requireThat(depth <= 16 && --budget.remaining >= 0);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { requireThat(Number.isFinite(value)); return; }
  requireThat(typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype));
  requireThat(Object.keys(value).length <= 128);
  Object.values(value).forEach(child => boundedJson(child, depth + 1, budget));
}
function validate(command) {
  boundedJson(command);
  keys(command, ['profile', 'audience', 'taskId', 'actorKey', 'operationId', 'issuedAt', 'expiresAt', 'expectedRevision', 'action', 'payload']);
  requireThat(command.profile === PROFILE && hex(command.audience, 64) && hex(command.actorKey, 64)
    && hex(command.operationId, 32) && typeof command.taskId === 'string'
    && command.taskId.length === 69 && command.taskId.startsWith('task_') && hex(command.taskId.slice(5), 64));
  requireThat(integer(command.issuedAt) && integer(command.expiresAt)
    && command.expiresAt > command.issuedAt && command.expiresAt - command.issuedAt <= LIMITS.proofMs);
  if (command.action === 'receipt') {
    requireThat(command.expectedRevision === null);
    keys(command.payload, ['operationId', 'commandDigest']);
    requireThat(hex(command.payload.operationId, 32) && hex(command.payload.commandDigest, 64));
    return;
  }
  requireThat(integer(command.expectedRevision));
  switch (command.action) {
    case 'claim': keys(command.payload, []); break;
    case 'submit':
      keys(command.payload, ['generation', 'resultPayload']);
      requireThat(bytes(canonicalizeJson(command.payload.resultPayload)) <= LIMITS.resultBytes);
      break;
    case 'release': keys(command.payload, ['generation']); break;
    case 'reopen':
      keys(command.payload, ['generation', 'resolutionDigest']);
      requireThat(hex(command.payload.resolutionDigest, 64)); break;
    default: fail('invalid');
  }
  if (command.action !== 'claim') requireThat(integer(command.payload.generation) && command.payload.generation > 0);
}
const signingText = command => PROFILE + '\n' + canonicalizeJson(command);

export async function signCommand(command, privateKey) {
  validate(command);
  // Snapshot before the first await: callers cannot change what gets signed.
  const snapshot = JSON.parse(canonicalizeJson(command));
  const key = await importEdPrivateKey(privateKey);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(signingText(snapshot)))));
  const wire = canonicalizeJson({ command: snapshot, signature });
  requireThat(bytes(wire) <= LIMITS.wireBytes);
  return wire;
}

export async function prepare(wire) {
  requireThat(typeof wire === 'string' && bytes(wire) <= LIMITS.wireBytes);
  let envelope;
  try { envelope = JSON.parse(wire); } catch { fail('invalid'); }
  keys(envelope, ['command', 'signature']);
  validate(envelope.command);
  requireThat(hex(envelope.signature, 128) && canonicalizeJson(envelope) === wire, 'noncanonical');
  const command = freeze(envelope.command);
  const key = await importEdPublicKey(command.actorKey);
  requireThat(await crypto.subtle.verify('Ed25519', key, hexToBytes(envelope.signature),
    new TextEncoder().encode(signingText(command))), 'signature');
  const digest = await sha256Hex(signingText(command));
  const resultDigest = command.action === 'submit' ? await sha256Hex(canonicalizeJson(command.payload.resultPayload)) : null;
  // Opaque verification capability, not a serializable proof of authorization.
  const token = Object.freeze({ digest });
  verified.set(token, { command, digest, resultDigest });
  return token;
}

export function initialState({ audience, taskId, creatorKey, timeoutMs = LIMITS.defaultLeaseMs,
  reassignment = 'manual', now }) {
  requireThat(hex(audience, 64) && hex(creatorKey, 64) && typeof taskId === 'string'
    && taskId.length === 69 && taskId.startsWith('task_') && hex(taskId.slice(5), 64));
  requireThat(integer(now) && integer(timeoutMs) && timeoutMs >= LIMITS.minLeaseMs && timeoutMs <= LIMITS.maxLeaseMs);
  requireThat(['manual', 'safe-to-repeat'].includes(reassignment));
  return freeze({ profile: PROFILE, audience, taskId, creatorKey, timeoutMs, reassignment,
    revision: 0, generation: 0, status: 'open', lease: null, result: null, updatedAt: now, receipts: [] });
}

function atBoundary(state, token, now) {
  const proof = verified.get(token);
  requireThat(proof, 'unverified');
  const { command } = proof;
  requireThat(state.profile === PROFILE && command.audience === state.audience && command.taskId === state.taskId, 'scope');
  requireThat(integer(now) && now >= state.updatedAt, 'clock');
  requireThat(command.issuedAt - now <= LIMITS.futureSkewMs && now < command.expiresAt, 'proof_expired');
  return proof;
}

export function commit(state, token, now) {
  // All async cryptography is over. A real adapter must perform this decision
  // AND its state/receipt/quota writes in one primary database transaction.
  const { command: c, digest, resultDigest } = atBoundary(state, token, now);
  requireThat(c.action !== 'receipt', 'read_only');
  const previous = state.receipts.find(r => r.actorKey === c.actorKey && r.operationId === c.operationId);
  if (previous) {
    requireThat(previous.commandDigest === digest, 'operation_conflict');
    return { state, receipt: previous, replayed: true, historical: true };
  }
  requireThat(c.expectedRevision === state.revision, 'revision');
  requireThat(state.status !== 'completed', 'sealed');
  requireThat(state.revision < Number.MAX_SAFE_INTEGER, 'capacity');
  const terminal = c.action === 'release' || c.action === 'submit';
  requireThat(state.receipts.length < LIMITS.receipts - (terminal ? 0 : 1), 'capacity');
  const next = structuredClone(state);
  const live = state.status === 'claimed' && now < state.lease.expiresAt;
  if (c.action === 'claim') {
    requireThat(state.generation < Number.MAX_SAFE_INTEGER, 'capacity');
    requireThat(!live, 'claimed');
    requireThat(state.status === 'open' || (state.status === 'claimed' && state.reassignment === 'safe-to-repeat'), 'reconciliation_required');
    requireThat(integer(now + state.timeoutMs), 'clock');
    next.status = 'claimed'; next.generation++;
    next.lease = { holderKey: c.actorKey, generation: next.generation, claimedAt: now, expiresAt: now + state.timeoutMs };
  } else {
    requireThat(c.payload.generation === state.generation, 'generation');
    if (c.action === 'reopen') {
      requireThat(c.actorKey === state.creatorKey, 'creator');
      requireThat(state.reassignment === 'manual' && !live
        && ['claimed', 'reconciliation'].includes(state.status), 'reconciliation_required');
      next.status = 'open'; next.lease = null;
    } else {
      requireThat(state.status === 'claimed' && state.lease.holderKey === c.actorKey, 'holder');
      if (c.action === 'submit') {
        requireThat(live, 'lease_expired');
        next.status = 'completed';
        next.result = { canonicalPayload: canonicalizeJson(c.payload.resultPayload), digest: resultDigest };
      } else {
        // Release after expiry remains valid for the unreassigned generation.
        next.status = state.reassignment === 'manual' ? 'reconciliation' : 'open';
        if (next.status === 'open') next.lease = null;
      }
    }
  }
  next.revision++; next.updatedAt = now;
  const receipt = { profile: PROFILE, audience: state.audience, taskId: state.taskId,
    actorKey: c.actorKey, operationId: c.operationId, commandDigest: digest,
    action: c.action, revision: next.revision, generation: next.generation,
    status: next.status, committedAt: now, leaseExpiresAt: next.lease?.expiresAt ?? null,
    resultDigest, resolutionDigest: c.action === 'reopen' ? c.payload.resolutionDigest : null };
  next.receipts.push(receipt);
  return { state: freeze(next), receipt, replayed: false, historical: true };
}

export function recover(state, token, now) {
  const { command: c } = atBoundary(state, token, now);
  requireThat(c.action === 'receipt', 'read_only');
  const receipt = state.receipts.find(r => r.actorKey === c.actorKey && r.operationId === c.payload.operationId
    && r.commandDigest === c.payload.commandDigest);
  // Neither result is current lease authority. Missing is NOT proof of no commit.
  return receipt ? { outcome: 'found', receipt: structuredClone(receipt), historical: true }
    : { outcome: 'unavailable', historical: true };
}

export function view(state, now) {
  requireThat(integer(now) && now >= state.updatedAt, 'clock');
  return { profile: state.profile, taskId: state.taskId, audience: state.audience,
    revision: state.revision, generation: state.generation, status: state.status,
    lease: structuredClone(state.lease),
    leaseState: state.status === 'claimed' ? (now < state.lease.expiresAt ? 'active' : 'expired') : 'none',
    reconciliationRequired: state.status === 'reconciliation'
      || (state.status === 'claimed' && now >= state.lease.expiresAt && state.reassignment === 'manual'),
    observedAt: now };
}
