import {
  deriveAgentId, registrationDigest, registrationOrigin, validRegistrationKey,
  verifyProfileRegistration, REGISTRATION_MAX_BYTES,
  type AgentIdentity, type SignedRegistration,
} from '@openagentforum/protocol';
import { normalizeDisplayName, displayNameKey } from './names.js';

export interface RegistrationRow {
  agent_id: string; public_key: string; name: string; name_key: string;
  x25519_public_key: string | null; capabilities_json: string; metadata_json: string;
  registered_at: number; last_seen_at: number; reputation_score: number; endpoint: string | null;
  profile_revision: number; registration_digest: string | null; registration_applied_at: number | null;
}
type Query = (sql: string, args: (string | number | null)[]) => Promise<RegistrationRow | null>;
export interface RegistrationStore {
  get(agentId: string): Promise<RegistrationRow | null>;
  announce(agentId: string, publicKey: string): Promise<RegistrationRow | null>;
  apply(agentId: string, proof: SignedRegistration, digest: string, name: string, nameKey: string): Promise<RegistrationRow | null>;
}
// SQLite evaluates 'now' consistently within one statement, including the CAS write.
const clock = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const normalizedHexCharacters = new Set(displayNameKey('0123456789abcdef'));

function configuredOrigin(origin: string | undefined): string | null {
  try { return origin ? registrationOrigin(origin) : null; } catch { return null; }
}

/** D1 queries must go to the primary; do not wrap this in a replica/session bookmark. */
export function sqlRegistrationStore(query: Query): RegistrationStore {
  return {
    get: id => query('SELECT * FROM agents WHERE agent_id = ?', [id]),
    announce: (id, key) => query(`INSERT INTO agents
      (agent_id, public_key, name, name_key, capabilities_json, metadata_json, registered_at, last_seen_at)
      VALUES (?, ?, ?, ?, '[]', '{}', ${clock}, ${clock})
      ON CONFLICT(agent_id) DO NOTHING RETURNING *`, [id, key, `Agent-${id.slice(6)}`, `!key:${key}`]),
    apply: (id, proof, digest, name, nameKey) => query(`
      INSERT INTO agents (agent_id, public_key, name, name_key, x25519_public_key,
        capabilities_json, metadata_json, endpoint, registered_at, last_seen_at,
        profile_revision, registration_digest, registration_applied_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ${clock}, ${clock}, ?, ?, ${clock}
      WHERE ${clock} >= ? AND ${clock} < ?
        AND (? = 0 OR EXISTS (SELECT 1 FROM agents WHERE agent_id = ?))
      ON CONFLICT(agent_id) DO UPDATE SET
        name = excluded.name, name_key = excluded.name_key,
        x25519_public_key = excluded.x25519_public_key,
        capabilities_json = excluded.capabilities_json, metadata_json = excluded.metadata_json,
        endpoint = excluded.endpoint, last_seen_at = excluded.last_seen_at,
        profile_revision = excluded.profile_revision, registration_digest = excluded.registration_digest,
        registration_applied_at = excluded.registration_applied_at
      WHERE agents.public_key = excluded.public_key AND agents.profile_revision = ?
        AND (agents.registration_applied_at IS NULL OR agents.registration_applied_at <= excluded.registration_applied_at)
      RETURNING *`, [id, proof.publicKey, name, nameKey, proof.profile.x25519PublicKey,
      JSON.stringify(proof.profile.capabilities), JSON.stringify(proof.profile.metadata), proof.profile.endpoint,
      proof.expectedRevision + 1, digest, proof.issuedAt - 30_000, proof.expiresAt,
      proof.expectedRevision, id, proof.expectedRevision]),
  };
}

export function registrationAgent(row: RegistrationRow): AgentIdentity {
  return {
    agentId: row.agent_id, publicKey: row.public_key, name: row.name,
    x25519PublicKey: row.x25519_public_key || undefined,
    capabilities: JSON.parse(row.capabilities_json), metadata: JSON.parse(row.metadata_json || '{}'),
    registeredAt: row.registered_at, lastSeenAt: row.last_seen_at,
    reputationScore: row.reputation_score, endpoint: row.endpoint || undefined,
    profileRevision: row.profile_revision, profileVerified: row.profile_revision > 0,
  };
}

/** Only the existing unbound/local Pages fallback. Never used after a D1 failure. */
export function memoryRegistrationStore(
  agents: Map<string, AgentIdentity>, receipts: Map<string, { digest: string; appliedAt: number }>,
): RegistrationStore {
  const row = (id: string): RegistrationRow | null => {
    const a = agents.get(id);
    if (!a) return null;
    const receipt = receipts.get(id);
    return { agent_id: id, public_key: a.publicKey, name: a.name, name_key: displayNameKey(a.name),
      x25519_public_key: a.x25519PublicKey ?? null, capabilities_json: JSON.stringify(a.capabilities),
      metadata_json: JSON.stringify(a.metadata ?? {}), registered_at: a.registeredAt, last_seen_at: a.lastSeenAt,
      reputation_score: a.reputationScore ?? 100, endpoint: a.endpoint ?? null,
      profile_revision: a.profileRevision ?? 0, registration_digest: receipt?.digest ?? null,
      registration_applied_at: receipt?.appliedAt ?? null };
  };
  return {
    get: async id => row(id),
    announce: async (id, key) => {
      if (agents.has(id)) return null;
      const now = Date.now();
      agents.set(id, { agentId: id, name: `Agent-${id.slice(6)}`, publicKey: key, capabilities: [], metadata: {},
        registeredAt: now, lastSeenAt: now, reputationScore: 100, profileRevision: 0, profileVerified: false });
      return row(id);
    },
    apply: async (id, proof, digest, name, nameKey) => {
      // No await between authorization, name uniqueness and mutation.
      const current = row(id);
      const now = Date.now();
      if (now < proof.issuedAt - 30_000 || now >= proof.expiresAt ||
          (current?.profile_revision ?? 0) !== proof.expectedRevision ||
          (current && (current.public_key !== proof.publicKey || now < (current.registration_applied_at ?? 0)))) return null;
      for (const a of agents.values()) {
        // New key-only announcements reserve no display name. Legacy profiles still do.
        if (a.agentId !== id && !(a.profileRevision === 0 && a.profileVerified === false) && displayNameKey(a.name) === nameKey) throw new NameConflict();
      }
      agents.set(id, { agentId: id, publicKey: proof.publicKey, name,
        x25519PublicKey: proof.profile.x25519PublicKey ?? undefined,
        capabilities: proof.profile.capabilities, metadata: proof.profile.metadata,
        endpoint: proof.profile.endpoint ?? undefined, registeredAt: current?.registered_at ?? now,
        lastSeenAt: now, reputationScore: current?.reputation_score ?? 100,
        profileRevision: proof.expectedRevision + 1, profileVerified: true });
      receipts.set(id, { digest, appliedAt: now });
      return row(id);
    },
  };
}

class NameConflict extends Error {}
class InputError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
    ...(status === 503 ? { 'Retry-After': '1' } : {}),
  } });
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new InputError('json_required', 415);
  if (Number(request.headers.get('content-length')) > REGISTRATION_MAX_BYTES) throw new InputError('registration_too_large', 413);
  if (!request.body) throw new InputError('invalid_registration', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new InputError('registration_read_timeout', 408)), 5000); });
  try {
    for (let reads = 0; ; reads++) {
      if (reads >= 4096) throw new InputError('invalid_registration', 400);
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > REGISTRATION_MAX_BYTES) throw new InputError('registration_too_large', 413);
      chunks.push(new Uint8Array(value));
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new InputError('invalid_registration', 400); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InputError('invalid_registration', 400);
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
    // Cancel on error/deadline without waiting for an untrusted producer's cancellation promise.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function outcome(row: RegistrationRow, replayed: boolean) {
  return { success: true, agent: registrationAgent(row), replayed, receipt: {
    digest: row.registration_digest, revision: row.profile_revision, appliedAt: row.registration_applied_at,
    historical: true,
  } };
}

export async function handleRegistration(request: Request, store: RegistrationStore, origin: string | undefined): Promise<Response> {
  const hub = configuredOrigin(origin);
  if (!hub) return json({ error: 'registration_not_configured' }, 503);
  try {
    const input = await body(request);
    if (Object.hasOwn(input, 'proofSignature') || Object.hasOwn(input, 'timestamp')) {
      return json({ error: 'registration_proof_upgrade_required', proofVersion: 2 }, 403);
    }
    if (!Object.hasOwn(input, 'proofVersion') && !Object.hasOwn(input, 'signature')) {
      const key = await validRegistrationKey(input.publicKey);
      if (!key) return json({ error: 'invalid_public_key' }, 400);
      const id = await deriveAgentId(key);
      const inserted = await store.announce(id, key);
      const row = inserted ?? await store.get(id);
      if (!row) throw new Error('Uncertain key announcement');
      if (row.public_key !== key) return json({ error: 'agent_key_conflict' }, 409);
      return json({ success: true, alreadyRegistered: !inserted, profileApplied: false,
        warning: 'Unsigned announcements register only the verification key. Use a v2 proof to claim a profile.',
        agent: registrationAgent(row) });
    }
    const proof = await verifyProfileRegistration(input, hub);
    if (!proof) return json({ error: 'invalid_registration_proof' }, 403);
    const normalized = normalizeDisplayName(proof.profile.name, '');
    if (!normalized.ok) return json({ error: 'invalid_display_name' }, 400);
    const id = await deriveAgentId(proof.publicKey);
    // Reserve generated Agent-<fingerprint> labels through the SAME comparison
    // policy as name uniqueness, so case, Unicode and punctuation cannot bypass it.
    const suffix = normalized.key.slice(5);
    if (normalized.key.startsWith('agent') && suffix.length >= 6 && suffix.length <= 16 &&
        [...suffix].every(char => normalizedHexCharacters.has(char)) && !displayNameKey(id.slice(6)).startsWith(suffix)) {
      return json({ error: 'reserved_agent_name' }, 400);
    }
    const digest = await registrationDigest(proof);
    const previous = await store.get(id);
    if (previous && previous.public_key !== proof.publicKey) return json({ error: 'agent_key_conflict' }, 409);
    // A retained exact receipt is historical success, even after proof expiry. No mutation/heartbeat.
    if (previous?.registration_digest === digest) return json(outcome(previous, true));
    const applied = await store.apply(id, proof, digest, normalized.name, normalized.key);
    if (applied) return json(outcome(applied, false));
    const current = await store.get(id);
    if (current?.public_key === proof.publicKey && current.registration_digest === digest) return json(outcome(current, true));
    // Only the latest receipt is retained. Never claim an unavailable older receipt did not commit.
    return json({ error: 'registration_not_applied', receiptAvailable: false,
      message: 'Revision or freshness check failed; an older attempt may already have committed. Read current state before deciding on a new action.' }, 409);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.code }, error.status);
    if (error instanceof NameConflict || (error instanceof Error && /UNIQUE constraint failed: agents\.name_key/.test(error.message))) return json({ error: 'display_name_claimed' }, 409);
    // Storage may have committed before throwing. No fallback and no affirmative failure receipt.
    return json({ error: 'registration_outcome_unknown', message: 'Retry the exact signed request; do not automatically rebase it.' }, 503);
  }
}

export async function handleRegistrationState(agentId: string, store: RegistrationStore, origin: string | undefined): Promise<Response> {
  const hub = configuredOrigin(origin);
  if (!hub) return json({ error: 'registration_not_configured' }, 503);
  if (!/^agent_[0-9a-f]{16}$/.test(agentId)) return json({ error: 'invalid_agent_id' }, 400);
  try {
    const row = await store.get(agentId);
    return json({ proofVersion: 2, hub, revision: row?.profile_revision ?? 0, agent: row ? registrationAgent(row) : null });
  } catch { return json({ error: 'registration_state_unavailable' }, 503); }
}
