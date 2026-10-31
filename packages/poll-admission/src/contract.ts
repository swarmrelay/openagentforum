/** Internal contract. All options are operator-owned; none come from a request. */
import { canonicalizeJson, POLL_REFUSALS, type PollRefusal, type MessageEnvelope, type StoredEnvelope } from '@openagentforum/protocol';
import { sameStoredEnvelope, storedEnvelope, type EnvelopeRow } from '@openagentforum/server/envelopes';
import { POLL_ACTION_LIMITS, POLL_WORK_LIMITS } from '@openagentforum/server/polls';
// Deliberate source-checkout dependency: this package is private and unpublished.
export { fitsPollActionInput } from '../../server/dist/poll-input.js';

export interface Capacity { rows: number; bytes: number }
export interface HistoryCapacity { records: number; bytes: number; nodes: number }
export interface PollAdmissionPolicy {
  service: Capacity;
  channel: Capacity;
  history: HistoryCapacity;
  wireBytes: number;
  windowMs: number;
  preparationMs: number;
  attempts: { ordinary: number; completion: number; recovery: number };
  captureRetention: number;
  wakeActive: boolean;
}
export interface PollAdmissionOptions {
  origin: string;
  generation: string;
  policyRevision: string;
  policy: PollAdmissionPolicy;
}
export type Lane = keyof PollAdmissionPolicy['attempts'];
export type WriteRoute = ({ lane?: 'ordinary'; pollId?: never } | { lane: 'completion'; pollId: string }) & { channel?: string };
/** Trusted composition callback, invoked once only AFTER the durable work charge.
 * The HTTP reader owns its byte/chunk/deadline bounds. No public reservation token. */
export type AdmissionInput = string | { read(): Promise<string>; signal?: AbortSignal };
export async function readAdmissionInput(input: AdmissionInput): Promise<string> {
  if (typeof input === 'string') return input;
  need(!input.signal?.aborted, 'preparation_expired');
  let wire: string;
  try { wire = await input.read(); }
  catch (error) {
    if (error instanceof PollAdmissionError) throw error;
    throw new PollAdmissionError('invalid_input');
  }
  need(!input.signal?.aborted, 'preparation_expired');
  return wire;
}
export interface Receipt {
  origin: string; generation: string; policyRevision: string;
  id: string; channel: string; actorKey: string; signature: string; checksum: string;
  storedSeq: number; pollRevision: number | null; committedAt: number; historical: true;
}
export type ReceiptResult = { outcome: 'unavailable'; historical: true }
  | { outcome: 'found'; receipt: Receipt; historical: true; replayed?: false };
export type AdmissionCode = 'configuration' | 'authority' | 'clock' | 'busy' | 'unavailable'
  | 'attempt_capacity' | 'input_limit' | 'invalid_input' | 'unsupported_profile' | 'signature'
  | 'route' | 'channel' | 'encryption' | 'operation_conflict' | 'unsupported_history'
  | 'history_capacity' | 'storage_capacity' | 'stale' | 'preparation_expired' | 'unprepared'
  | 'poll_refused' | PollRefusal;
export class PollAdmissionError extends Error {
  constructor(readonly code: AdmissionCode) { super(code); }
}
export function need(ok: unknown, code: AdmissionCode): asserts ok {
  if (!ok) throw new PollAdmissionError(code);
}
const encoder = new TextEncoder();
export const bytes = (text: string): number => encoder.encode(text).byteLength;
export const safe = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export const equal = (a: unknown, b: unknown): boolean => canonicalizeJson(a) === canonicalizeJson(b);
// Negative character classes plus explicit lengths also reject trailing line
// separators, which JavaScript's `$` assertion alone would allow.
export const messageIdentifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  && v.length <= 128 && !/[^a-zA-Z0-9_:-]/.test(v);
export const channelIdentifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  && v.length <= 128 && !/[^a-z0-9_-]/.test(v);
export const agentIdentifier = (v: unknown): v is string => typeof v === 'string' && v.length === 22 && /^agent_[0-9a-f]{16}$/.test(v);
export const hex = (v: unknown, length: number): v is string => typeof v === 'string' && v.length === length && !/[^0-9a-f]/i.test(v);
export const FIXED_ROW_BYTES = 4096;
export const GUARD_ROW_BYTES = 16384;
export const RECEIPT_BYTES = 4096;
export const CAPTURE_BYTES = 1024;
export const CLOSE_BYTES = POLL_ACTION_LIMITS.envelopeBytes + 512 + 16;
export const CLOSE_RESERVATION: Readonly<Capacity> = Object.freeze({ rows: 4, bytes: CLOSE_BYTES + RECEIPT_BYTES + 2 * CAPTURE_BYTES });
export const CLOSE_HISTORY: Readonly<HistoryCapacity> = Object.freeze({ records: 1, bytes: CLOSE_BYTES, nodes: POLL_ACTION_LIMITS.nodes });
export const MAX_IN_FLIGHT = 8;
export const wireColumns = ['id', 'channel', 'sender', 'type', 'sequence', 'stored_seq', 'timestamp', 'payload_json',
  'signature', 'checksum', 'encrypted', 'reply_to_id', 'recipient_keys_json', 'ephemeral_public_key', 'nonce'] as const;
export const columnCostSql = (columns: readonly string[]) => '512 + ' + columns.map(c => `COALESCE(length(CAST(${c} AS BLOB)), 0)`).join(' + ');
export const columnCost = (columns: readonly unknown[]) => 512 + columns.reduce<number>((sum, value) => sum + (value == null ? 0 : bytes(String(value))), 0);
export const plus = (a: Capacity, b: Capacity): Capacity => ({ rows: a.rows + b.rows, bytes: a.bytes + b.bytes });
export const minus = (a: Capacity, b: Capacity): Capacity => ({ rows: a.rows - b.rows, bytes: a.bytes - b.bytes });
export const within = <T extends object>(used: T, cap: T) => Object.keys(cap).every(k => {
  const key = k as keyof T; return safe(used[key]) && (used[key] as number) <= (cap[key] as number);
});
function keys(value: object, expected: string[]) {
  need(value && equal(Object.keys(value).sort(), expected.sort()), 'configuration');
}
export function configuration(options: PollAdmissionOptions) {
  try {
    const copy = structuredClone(options);
    keys(copy, ['origin', 'generation', 'policyRevision', 'policy']);
    const url = new URL(copy.origin);
    need(url.protocol === 'https:' && url.origin === copy.origin && bytes(copy.origin) <= 256, 'configuration');
    need(hex(copy.generation, 64) && copy.generation === copy.generation.toLowerCase()
      && typeof copy.policyRevision === 'string' && copy.policyRevision.length > 0 && copy.policyRevision.length <= 128
      && !/[^a-zA-Z0-9_.:-]/.test(copy.policyRevision), 'configuration');
    const p = copy.policy;
    keys(p, ['service', 'channel', 'history', 'wireBytes', 'windowMs', 'preparationMs', 'attempts', 'captureRetention', 'wakeActive']);
    for (const cap of [p.service, p.channel]) {
      keys(cap, ['rows', 'bytes']);
      need(safe(cap.rows) && cap.rows <= 1_000_000_000 && safe(cap.bytes) && cap.bytes <= 2 ** 50, 'configuration');
    }
    keys(p.history, ['records', 'bytes', 'nodes']);
    need(within(p.history, { records: POLL_WORK_LIMITS.records, bytes: POLL_WORK_LIMITS.bytes, nodes: POLL_WORK_LIMITS.nodes })
      && p.history.records >= 2, 'configuration');
    need(safe(p.wireBytes) && p.wireBytes > 0 && p.wireBytes <= 262144
      && safe(p.windowMs) && p.windowMs > 0 && p.windowMs <= 86400000
      && safe(p.preparationMs) && p.preparationMs > 0 && p.preparationMs <= Math.min(5000, p.windowMs)
      && safe(p.captureRetention) && p.captureRetention > 0 && p.captureRetention <= 10000
      && typeof p.wakeActive === 'boolean', 'configuration');
    keys(p.attempts, ['ordinary', 'completion', 'recovery']);
    need(Object.values(p.attempts).every(n => safe(n) && n <= 1_000_000), 'configuration');
    const policyJson = canonicalizeJson(p);
    need(bytes(policyJson) <= 2048, 'configuration');
    // No mutable caller object survives the configuration boundary.
    return { ...copy, policyJson };
  } catch { throw new PollAdmissionError('configuration'); }
}

/** Bounded before recursive canonicalization or cryptography. */
export function tree(value: unknown): number {
  const pending: [unknown, number][] = [[value, 0]];
  let nodes = 0;
  while (pending.length) {
    const [v, depth] = pending.pop()!;
    need(++nodes <= POLL_WORK_LIMITS.recordNodes && depth <= POLL_WORK_LIMITS.depth, 'input_limit');
    if (typeof v === 'number') need(Number.isFinite(v), 'invalid_input');
    if (v && typeof v === 'object') {
      const entries = Object.keys(v);
      need(entries.length <= POLL_WORK_LIMITS.entries && nodes + pending.length + entries.length <= POLL_WORK_LIMITS.recordNodes, 'input_limit');
      for (const key of entries) {
        need(key.length <= POLL_WORK_LIMITS.propertyLength, 'input_limit');
        pending.push([(v as Record<string, unknown>)[key], depth + 1]);
      }
    }
  }
  return nodes;
}
export function parseWire(wire: string, policy: Pick<PollAdmissionPolicy, 'wireBytes'>): MessageEnvelope<any> {
  need(typeof wire === 'string' && wire.length <= policy.wireBytes && bytes(wire) <= policy.wireBytes, 'input_limit');
  let env;
  try { env = JSON.parse(wire); } catch { throw new PollAdmissionError('invalid_input'); }
  tree(env);
  need(env && typeof env === 'object' && !Array.isArray(env), 'invalid_input');
  need(messageIdentifier(env.id) && channelIdentifier(env.channel) && agentIdentifier(env.sender)
    && safe(env.sequence) && safe(env.timestamp)
    && hex(env.checksum, 64) && hex(env.signature, 128), 'invalid_input');
  need(['poll', 'vote', 'intel'].includes(env.type) && env.payload !== undefined, 'unsupported_profile');
  return env;
}
export function recordRow(env: MessageEnvelope<any>, storedSeq: number): EnvelopeRow {
  return { id: env.id, channel: env.channel, sender: env.sender, type: env.type, sequence: env.sequence,
    stored_seq: storedSeq, timestamp: env.timestamp, payload_json: JSON.stringify(env.payload), signature: env.signature,
    checksum: env.checksum, encrypted: env.encrypted === true ? 1 : 0, reply_to_id: env.replyToId ?? null,
    recipient_keys_json: env.recipientKeys == null ? null : JSON.stringify(env.recipientKeys),
    ephemeral_public_key: env.ephemeralPublicKey ?? null, nonce: env.nonce ?? null };
}
export const recordCost = (row: EnvelopeRow) => columnCost(wireColumns.map(k => row[k]));
export function decodeRow(row: EnvelopeRow): StoredEnvelope {
  need(recordCost(row) <= POLL_WORK_LIMITS.recordBytes, 'history_capacity');
  const env = storedEnvelope(row);
  tree(env.payload);
  if (env.recipientKeys !== undefined) tree(env.recipientKeys);
  return env;
}
export function exact(saved: MessageEnvelope<any>, incoming: MessageEnvelope<any>): boolean {
  const signed = (env: MessageEnvelope<any>) => ({ id: env.id, channel: env.channel, sender: env.sender, type: env.type,
    sequence: env.sequence, timestamp: env.timestamp, checksum: env.checksum, payload: env.payload });
  return equal(signed(saved), signed(incoming)) && sameStoredEnvelope(saved, incoming);
}
export function refusal(reason: string | null | undefined) {
  if (!reason) return;
  throw new PollAdmissionError((POLL_REFUSALS as readonly string[]).includes(reason) ? reason as AdmissionCode : 'poll_refused');
}
