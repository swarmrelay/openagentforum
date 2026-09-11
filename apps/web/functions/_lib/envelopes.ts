import type { MessageEnvelope } from '@openagentforum/protocol';

/** Keep transport metadata intact on every durable read, including SSE. */
export interface EnvelopeRow {
  id: string; channel: string; sender: string; type: MessageEnvelope['type'];
  sequence: number; stored_seq: number | null; timestamp: number;
  payload_json: string; signature: string; checksum: string; encrypted: number;
  reply_to_id: string | null; recipient_keys_json: string | null;
  ephemeral_public_key: string | null; nonce: string | null;
}

export function storedEnvelope(row: EnvelopeRow): MessageEnvelope & { storedSeq: number } {
  return {
    id: row.id, channel: row.channel, sender: row.sender, type: row.type,
    sequence: row.sequence, storedSeq: row.stored_seq ?? row.sequence, timestamp: row.timestamp,
    payload: JSON.parse(row.payload_json), signature: row.signature, checksum: row.checksum,
    encrypted: row.encrypted === 1,
    replyToId: row.reply_to_id ?? undefined,
    recipientKeys: row.recipient_keys_json == null ? undefined : JSON.parse(row.recipient_keys_json),
    ephemeralPublicKey: row.ephemeral_public_key ?? undefined,
    nonce: row.nonce ?? undefined,
  };
}

/** A format check, not proof that a sender encrypted honestly or holds a room key. */
export function encryptionError(envelope: Record<string, unknown>, required: boolean): string | null {
  if (required && envelope.encrypted !== true) return 'encryption_required';
  if (envelope.encrypted !== undefined && typeof envelope.encrypted !== 'boolean') return 'invalid_encryption_metadata';
  if (envelope.replyToId !== undefined && typeof envelope.replyToId !== 'string') return 'invalid_envelope_metadata';
  if (envelope.nonce !== undefined && (typeof envelope.nonce !== 'string' || !/^[a-fA-F0-9]{24}$/.test(envelope.nonce))) return 'invalid_encryption_metadata';
  if (envelope.ephemeralPublicKey !== undefined && (typeof envelope.ephemeralPublicKey !== 'string' || !/^[a-fA-F0-9]{64}$/.test(envelope.ephemeralPublicKey))) return 'invalid_encryption_metadata';
  if (envelope.recipientKeys !== undefined) {
    const keys = envelope.recipientKeys;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) ||
        Object.entries(keys).some(([id, value]) => !/^agent_[a-f0-9]{16}$/.test(id) || typeof value !== 'string')) return 'invalid_encryption_metadata';
  }
  if (envelope.encrypted === true) {
    const payload = envelope.payload;
    // No plaintext side fields beside ciphertext. The relay cannot validate the GCM tag.
    const ciphertext = typeof payload === 'string' ? payload :
      payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 1 ?
        (payload as Record<string, unknown>).ciphertext : undefined;
    if (!envelope.nonce || typeof ciphertext !== 'string' || !/^(?:[a-fA-F0-9]{2}){16,}$/.test(ciphertext)) return 'invalid_encryption_metadata';
  }
  return null;
}
