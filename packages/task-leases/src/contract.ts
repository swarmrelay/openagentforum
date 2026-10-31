/** Internal native implementation of RFC 0007. No legacy proof reinterpretation. */
import { canonicalizeJson, sha256Hex, importEdPublicKey, importEdPrivateKey, bytesToHex, hexToBytes } from '@openagentforum/protocol';

export const PROFILE = 'oaf-task-lease-v1';
export const LIMITS = Object.freeze({ minLeaseMs: 60000, maxLeaseMs: 86400000, proofMs: 300000, futureSkewMs: 30000,
  wireBytes: 32768, resultBytes: 16384, stateBytes: 262144, receiptBytes: 4096, receipts: 128, lifetimeMs: 5000, inFlight: 8 });
// Preallocate maximum retained task row and creation receipt/wire for its whole
// lifetime. This includes all 128 transition receipts and the final result.
export const TASK_BYTES = LIMITS.stateBytes + LIMITS.wireBytes + LIMITS.receiptBytes + 512;
export const FIXED_BYTES = 4096, GUARD_BYTES = 1048576;
export type Action = 'create' | 'claim' | 'submit' | 'release' | 'reopen' | 'receipt';
export type Lane = 'ordinary' | 'completion' | 'recovery';
export type Code = 'configuration' | 'authority' | 'clock' | 'busy' | 'unavailable' | 'invalid' | 'signature'
  | 'scope' | 'route' | 'proof_expired' | 'operation_conflict' | 'revision' | 'sealed' | 'capacity' | 'attempt_capacity'
  | 'claimed' | 'reconciliation_required' | 'generation' | 'creator' | 'holder' | 'lease_expired' | 'unprepared'
  | 'preparation_expired' | 'stale';
export class TaskLeaseError extends Error { constructor(readonly code: Code) { super(code); } }
export function need(ok: unknown, code: Code = 'invalid'): asserts ok { if (!ok) throw new TaskLeaseError(code); }
export const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
export const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && !Object.is(v, -0);
export const hex = (v: unknown, length: number): v is string => typeof v === 'string' && v.length === length && !/[^0-9a-f]/.test(v);
export const taskId = (v: unknown): v is string => typeof v === 'string' && v.startsWith('task_') && hex(v.slice(5), 64);
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function keys(v: unknown, names: string[]): asserts v is Record<string, unknown> {
  need(object(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k)));
}
export function bounded(value: unknown) {
  const pending: Array<[unknown, number]> = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [v, depth] = pending.pop()!;
    need(++nodes <= 1024 && depth <= 16);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') continue;
    if (typeof v === 'number') { need(Number.isFinite(v)); continue; }
    need(typeof v === 'object');
    const values = Object.values(v); need(values.length <= 128 && nodes + pending.length + values.length <= 1024);
    for (const child of values) pending.push([child, depth + 1]);
  }
}
export interface TaskContent { title: string; description: string; requiredCapabilities: string[]; reward: string | null }
export interface Creation extends TaskContent { timeoutMs: number; reassignment: 'manual' | 'safe-to-repeat' }
interface Common { profile: typeof PROFILE; audience: string; actorKey: string; operationId: string; issuedAt: number; expiresAt: number }
export type Command = Common & (
  | { action: 'create'; taskId: null; expectedRevision: null; payload: Creation }
  | { action: 'claim'; taskId: string; expectedRevision: number; payload: Record<string, never> }
  | { action: 'submit'; taskId: string; expectedRevision: number; payload: { generation: number; resultPayload: unknown } }
  | { action: 'release'; taskId: string; expectedRevision: number; payload: { generation: number } }
  | { action: 'reopen'; taskId: string; expectedRevision: number; payload: { generation: number; resolutionDigest: string } }
  | { action: 'receipt'; taskId: string; expectedRevision: null; payload: { operationId: string; commandDigest: string } }
);
export interface Proof { command: Command; digest: string; resultDigest: string | null; taskId: string; wire: string }
export interface Lease { holderKey: string; generation: number; claimedAt: number; expiresAt: number }
export type Status = 'open' | 'claimed' | 'reconciliation' | 'completed';
export interface Receipt {
  profile: typeof PROFILE; audience: string; taskId: string; actorKey: string; operationId: string; commandDigest: string;
  action: Exclude<Action, 'receipt'>; revision: number; generation: number; status: Status; committedAt: number;
  leaseExpiresAt: number | null; resultDigest: string | null; resolutionDigest: string | null;
}
export interface State {
  profile: typeof PROFILE; audience: string; taskId: string; creatorKey: string; timeoutMs: number;
  reassignment: 'manual' | 'safe-to-repeat'; content: TaskContent;
  revision: number; generation: number; status: Status; lease: Lease | null;
  result: { canonicalPayload: string; digest: string } | null; updatedAt: number; receipts: Receipt[];
}
export type Result = { outcome: 'found'; receipt: Receipt; historical: true; replayed?: boolean }
  | { outcome: 'unavailable'; historical: true };
export interface Policy {
  maxTasks: number; maxBytes: number; maxActors: number; creatorTasks: number; actorActions: number;
  windowMs: number; preparationMs: number; attempts: Record<Lane, number>;
}
export interface Options { origin: string; audience: string; generation: string; policyRevision: string; policy: Policy }
/** A trusted transport can defer bounded body consumption until after charging. */
export type Input = string | { read(): Promise<string>; signal?: AbortSignal };
export function configuration(options: Options) {
  try {
    const copy = structuredClone(options); keys(copy, ['origin', 'audience', 'generation', 'policyRevision', 'policy']);
    const url = new URL(copy.origin);
    need(url.protocol === 'https:' && url.origin === copy.origin && bytes(copy.origin) <= 256
      && hex(copy.audience, 64) && hex(copy.generation, 64) && typeof copy.policyRevision === 'string'
      && copy.policyRevision.length > 0 && copy.policyRevision.length <= 128 && !/[^a-zA-Z0-9_.:-]/.test(copy.policyRevision));
    const p = copy.policy;
    keys(p, ['maxTasks', 'maxBytes', 'maxActors', 'creatorTasks', 'actorActions', 'windowMs', 'preparationMs', 'attempts']);
    for (const value of [p.maxTasks, p.maxBytes, p.maxActors, p.creatorTasks, p.actorActions, p.windowMs, p.preparationMs]) need(integer(value) && value > 0);
    need(p.maxTasks <= 1000000 && p.maxBytes <= 2 ** 50 && p.maxActors <= 1000000 && p.creatorTasks <= p.maxTasks
      && p.actorActions <= 1000000 && p.windowMs <= 86400000 && p.preparationMs <= Math.min(LIMITS.lifetimeMs, p.windowMs));
    keys(p.attempts, ['ordinary', 'completion', 'recovery']);
    need(Object.values(p.attempts).every(v => integer(v) && v <= 1000000));
    return { ...copy, policyJson: canonicalizeJson(p) };
  } catch { throw new TaskLeaseError('configuration'); }
}
export function validate(command: unknown): asserts command is Command {
  bounded(command);
  keys(command, ['profile', 'audience', 'taskId', 'actorKey', 'operationId', 'issuedAt', 'expiresAt', 'expectedRevision', 'action', 'payload']);
  need(command.profile === PROFILE && hex(command.audience, 64) && hex(command.actorKey, 64) && hex(command.operationId, 32));
  need(integer(command.issuedAt) && integer(command.expiresAt) && command.expiresAt > command.issuedAt
    && command.expiresAt - command.issuedAt <= LIMITS.proofMs);
  if (command.action === 'create') {
    need(command.taskId === null && command.expectedRevision === null);
    const p = command.payload;
    keys(p, ['title', 'description', 'requiredCapabilities', 'reward', 'timeoutMs', 'reassignment']);
    need(typeof p.title === 'string' && p.title.trim().length > 0 && bytes(p.title) <= 256
      && typeof p.description === 'string' && bytes(p.description) <= 16384
      && Array.isArray(p.requiredCapabilities) && p.requiredCapabilities.length <= 32
      && p.requiredCapabilities.every(c => typeof c === 'string' && c.length > 0 && bytes(c) <= 64)
      && new Set(p.requiredCapabilities).size === p.requiredCapabilities.length
      && (p.reward === null || typeof p.reward === 'string' && bytes(p.reward) <= 1024)
      && integer(p.timeoutMs) && p.timeoutMs >= LIMITS.minLeaseMs && p.timeoutMs <= LIMITS.maxLeaseMs
      && (p.reassignment === 'manual' || p.reassignment === 'safe-to-repeat'));
    return;
  }
  need(taskId(command.taskId));
  const p = command.payload;
  if (command.action === 'receipt') {
    need(command.expectedRevision === null); keys(p, ['operationId', 'commandDigest']);
    need(hex(p.operationId, 32) && hex(p.commandDigest, 64)); return;
  }
  need(integer(command.expectedRevision));
  if (command.action === 'claim') { keys(p, []); return; }
  if (command.action === 'submit') { keys(p, ['generation', 'resultPayload']); need(bytes(canonicalizeJson(p.resultPayload)) <= LIMITS.resultBytes); }
  else if (command.action === 'release') keys(p, ['generation']);
  else if (command.action === 'reopen') { keys(p, ['generation', 'resolutionDigest']); need(hex(p.resolutionDigest, 64)); }
  else throw new TaskLeaseError('invalid');
  need(integer(p.generation) && p.generation > 0);
}
export const signingText = (command: Command) => PROFILE + '\n' + canonicalizeJson(command);
export async function signCommand(command: Command, privateKey: string): Promise<string> {
  validate(command); const copy = JSON.parse(canonicalizeJson(command)) as Command;
  const key = await importEdPrivateKey(privateKey);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(signingText(copy)))));
  const wire = canonicalizeJson({ command: copy, signature }); need(bytes(wire) <= LIMITS.wireBytes); return wire;
}
export async function verifyWire(wire: string): Promise<Proof> {
  need(typeof wire === 'string' && wire.length <= LIMITS.wireBytes && bytes(wire) <= LIMITS.wireBytes);
  let envelope: unknown; try { envelope = JSON.parse(wire); } catch { throw new TaskLeaseError('invalid'); }
  keys(envelope, ['command', 'signature']); validate(envelope.command);
  need(hex(envelope.signature, 128) && canonicalizeJson(envelope) === wire);
  const command = envelope.command;
  let valid = false;
  try { valid = await crypto.subtle.verify('Ed25519', await importEdPublicKey(command.actorKey), new Uint8Array(hexToBytes(envelope.signature)),
    new TextEncoder().encode(signingText(command))); } catch { /* Fixed error only. */ }
  need(valid, 'signature');
  const digest = await sha256Hex(signingText(command));
  return { command, digest, taskId: command.action === 'create' ? 'task_' + digest : command.taskId, wire,
    resultDigest: command.action === 'submit' ? await sha256Hex(canonicalizeJson(command.payload.resultPayload)) : null };
}
export function fresh(proof: Proof, audience: string, now: number) {
  need(proof.command.audience === audience, 'scope'); need(integer(now), 'clock');
  need(proof.command.issuedAt - now <= LIMITS.futureSkewMs && now < proof.command.expiresAt, 'proof_expired');
}
export function makeReceipt(state: State, proof: Proof, now: number): Receipt {
  const c = proof.command; need(c.action !== 'receipt');
  return { profile: PROFILE, audience: state.audience, taskId: state.taskId, actorKey: c.actorKey,
    operationId: c.operationId, commandDigest: proof.digest, action: c.action, revision: state.revision,
    generation: state.generation, status: state.status, committedAt: now, leaseExpiresAt: state.lease?.expiresAt ?? null,
    resultDigest: proof.resultDigest, resolutionDigest: c.action === 'reopen' ? c.payload.resolutionDigest : null };
}
export function initial(proof: Proof, now: number): State {
  const c = proof.command; need(c.action === 'create');
  const { timeoutMs, reassignment, ...content } = c.payload;
  return { profile: PROFILE, audience: c.audience, taskId: proof.taskId, creatorKey: c.actorKey, timeoutMs, reassignment,
    content, revision: 0, generation: 0, status: 'open', lease: null, result: null, updatedAt: now, receipts: [] };
}
export function decide(state: State, proof: Proof, now: number): State {
  const c = proof.command; need(c.action !== 'create' && c.action !== 'receipt');
  fresh(proof, state.audience, now); need(state.taskId === proof.taskId, 'scope'); need(now >= state.updatedAt, 'clock');
  need(c.expectedRevision === state.revision, 'revision'); need(state.status !== 'completed', 'sealed');
  need(state.revision < Number.MAX_SAFE_INTEGER, 'capacity');
  const terminal = c.action === 'release' || c.action === 'submit';
  need(state.receipts.length < LIMITS.receipts - (terminal ? 0 : 1), 'capacity');
  const next = structuredClone(state), live = state.status === 'claimed' && now < state.lease!.expiresAt;
  if (c.action === 'claim') {
    need(state.generation < Number.MAX_SAFE_INTEGER, 'capacity'); need(!live, 'claimed');
    need(state.status === 'open' || state.status === 'claimed' && state.reassignment === 'safe-to-repeat', 'reconciliation_required');
    need(integer(now + state.timeoutMs), 'clock');
    next.status = 'claimed'; next.generation++;
    next.lease = { holderKey: c.actorKey, generation: next.generation, claimedAt: now, expiresAt: now + state.timeoutMs };
  } else {
    need(c.payload.generation === state.generation, 'generation');
    if (c.action === 'reopen') {
      need(c.actorKey === state.creatorKey, 'creator');
      need(state.reassignment === 'manual' && !live && ['claimed', 'reconciliation'].includes(state.status), 'reconciliation_required');
      next.status = 'open'; next.lease = null;
    } else {
      need(state.status === 'claimed' && state.lease?.holderKey === c.actorKey, 'holder');
      if (c.action === 'submit') {
        need(live, 'lease_expired'); next.status = 'completed';
        next.result = { canonicalPayload: canonicalizeJson(c.payload.resultPayload), digest: proof.resultDigest! };
      } else { next.status = state.reassignment === 'manual' ? 'reconciliation' : 'open'; if (next.status === 'open') next.lease = null; }
    }
  }
  next.revision++; next.updatedAt = now; next.receipts.push(makeReceipt(next, proof, now)); return next;
}
export function view(state: State, now: number) {
  need(integer(now) && now >= state.updatedAt, 'clock');
  return { profile: PROFILE, audience: state.audience, taskId: state.taskId, content: structuredClone(state.content),
    revision: state.revision, generation: state.generation, status: state.status, lease: structuredClone(state.lease),
    leaseState: state.status === 'claimed' ? now < state.lease!.expiresAt ? 'active' : 'expired' : 'none',
    reconciliationRequired: state.status === 'reconciliation' || state.status === 'claimed'
      && now >= state.lease!.expiresAt && state.reassignment === 'manual', observedAt: now };
}
