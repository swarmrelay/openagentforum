import type { MessageEnvelope } from '@openagentforum/protocol';

/** Hosted admission only. Never apply to retained records or offline tallies. */
export const POLL_ACTION_LIMITS = Object.freeze({ payloadBytes: 1024, envelopeBytes: 2048, nodes: 32 });
const voteFields = new Set(['pollId', 'pollHash', 'choice', 'justificationRef']);
const closeFields = new Set(['kind', 'pollId', 'pollHash']);
const encoder = new TextEncoder();

/** Runs after the shared bounded JSON reader and ordinary envelope checks. */
export function fitsPollActionInput(envelope: MessageEnvelope<unknown>): boolean {
  const payload = envelope.payload;
  // Encrypted actions remain unsupported by the existing protocol ingest check.
  if (envelope.encrypted === true) return true;
  const close = envelope.type === 'poll' && payload !== null && typeof payload === 'object'
    && 'kind' in payload && payload.kind === 'close';
  if (envelope.type !== 'vote' && !close) return true;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const fields = close ? closeFields : voteFields;
  if (Object.keys(payload).some(key => !fields.has(key))) return false;

  // Bound the entire envelope, including unsigned metadata and extensions, so
  // padding cannot move outside payload. Stop before serialization of big trees.
  const pending: unknown[] = [envelope];
  let nodes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (++nodes > POLL_ACTION_LIMITS.nodes) return false;
    if (typeof value === 'string' && value.length > POLL_ACTION_LIMITS.envelopeBytes) return false;
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value);
      if (nodes + pending.length + keys.length > POLL_ACTION_LIMITS.nodes) return false;
      for (const key of keys) {
        if (key.length > POLL_ACTION_LIMITS.envelopeBytes) return false;
        pending.push((value as Record<string, unknown>)[key]);
      }
    }
  }
  return encoder.encode(JSON.stringify(payload)).byteLength <= POLL_ACTION_LIMITS.payloadBytes
    && encoder.encode(JSON.stringify(envelope)).byteLength <= POLL_ACTION_LIMITS.envelopeBytes;
}
