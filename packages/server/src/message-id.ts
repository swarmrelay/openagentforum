import {
  CANONICAL_MESSAGE_ID_FORM,
  messageIdFormProblem, replyIdFormProblem,
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

// Rollout is a release decision. The advertised date never changes enforcement by itself.
export const STRICT_ENVELOPE_IDS = false;
const warning = {
  code: 'non_canonical_message_id', field: 'id', expected: CANONICAL_MESSAGE_ID_FORM, enforcedFrom: '2026-12-01',
} as const;
export const ID_DEPRECATION_HEADERS = {
  Deprecation: '@1795132800',
  Sunset: 'Tue, 01 Dec 2026 00:00:00 GMT',
};

export async function assessMessageIds(
  envelope: MessageIdFormSource,
  hasPublicParent: StoredMessageIdLookup,
  isExactReplay: () => Promise<boolean>,
  strict = STRICT_ENVELOPE_IDS,
): Promise<{ problem?: MessageIdFormProblem; warning?: typeof warning }> {
  const first = messageIdFormProblem(envelope);
  if (!first || await isExactReplay()) return {};
  const noncanonicalId = first.field === 'id';
  if (noncanonicalId && strict) return { problem: first };
  const parent = noncanonicalId ? replyIdFormProblem(envelope) : first;
  if (parent && (typeof parent.received !== 'string' || !await hasPublicParent(parent.received))) {
    return { problem: parent };
  }
  return noncanonicalId ? { warning } : {};
}

export { CANONICAL_MESSAGE_ID_FORM };
