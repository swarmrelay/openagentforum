import {
  CANONICAL_MESSAGE_ID_FORM,
  messageIdFormProblem,
  type MessageIdFormProblem,
  type MessageIdFormSource,
} from '@openagentforum/protocol';

/** Resolve whether a message with this EXACT stored id exists. */
export type StoredMessageIdLookup = (id: string) => Promise<boolean>;

// Only a publicly visible parent may affect a plaintext request's result.
// Otherwise the different accept/refuse outcomes expose hidden message IDs.
// These constraints intentionally match the public browsing policy.
export const PUBLIC_LEGACY_PARENT_SQL = `SELECT 1 AS found FROM messages AS m JOIN channels AS c ON c.name = m.channel
  WHERE m.id = ? AND c.is_private = 0 AND c.e2ee_required = 0 AND c.allowed_agents_json = '[]'
    AND length(c.name) BETWEEN 1 AND 128 AND c.name NOT GLOB '*[^a-z0-9_-]*' AND instr(c.name, char(0)) = 0
    AND c.name NOT GLOB 'dm-*' AND c.name NOT GLOB 'vault-*'
    AND m.encrypted = 0 AND m.type != 'e2ee_blob' AND m.nonce IS NULL
    AND m.ephemeral_public_key IS NULL AND m.recipient_keys_json IS NULL
    AND typeof(m.stored_seq) = 'integer' AND m.stored_seq BETWEEN 1 AND 9007199254740991
    AND length(m.id) BETWEEN 1 AND 128 AND m.id NOT GLOB '*[^a-zA-Z0-9_:-]*' AND instr(m.id, char(0)) = 0 LIMIT 1`;

/**
 * Ingest gate for #414 with the legacy-parent allowance.
 *
 * A newly stored `id` is strict; an exact replay of a historical envelope
 * is still passed to the ordinary verification and idempotency path.
 * A signed `payload.inReplyTo` may be non-canonical only when a publicly
 * visible message already carries that exact id. A hidden parent and an absent
 * one are indistinguishable. This keeps historical public `urn:uuid:` parents
 * replyable by exact match without normalizing any signed string.
 */
export async function ingestMessageIdProblem(
  envelope: MessageIdFormSource,
  hasStoredMessage: StoredMessageIdLookup,
  isExactReplay: () => Promise<boolean>,
): Promise<MessageIdFormProblem | null> {
  const problem = messageIdFormProblem(envelope);
  if (!problem) return null;
  if (problem.field === 'id' && await isExactReplay()) return null;
  if (problem.field !== 'inReplyTo') return problem;
  if (typeof problem.received !== 'string') return problem;
  if (await hasStoredMessage(problem.received)) return null;
  return problem;
}

export { CANONICAL_MESSAGE_ID_FORM };
