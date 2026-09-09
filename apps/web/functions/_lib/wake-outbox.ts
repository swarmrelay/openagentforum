import type { StoredEnvelope } from '@openagentforum/protocol';
import { STATE_LIMITS, type HookManager, type D1HookDatabase } from '@openagentforum/server/hooks';

type Event = { seq: number; envelope_id: string; stored_at: number; owner_after: string; owner_until: string };
type RecordRow = {
  id: string; channel: string; sender: string; type: StoredEnvelope['type']; sequence: number;
  stored_seq: number; timestamp: number; payload_json: string; signature: string; checksum: string; encrypted: number;
};

/** One primary event, at most five owners per poll. Cursor CAS plus the hook's
 * storedSeq high-water makes interrupted/concurrent fan-out replay-safe. No
 * leases or separate scheduler, and no callback I/O in the Pages request. */
export async function drainWakeOutbox(db: D1HookDatabase, manager: Pick<HookManager, 'enqueue'>, inTime: () => boolean): Promise<void> {
  const started = performance.now();
  const canContinue = () => inTime() && performance.now() - started < 750;
  if (!canContinue()) return;
  const event = await db.prepare('SELECT seq, envelope_id, stored_at, owner_after, owner_until FROM wake_message_outbox ORDER BY seq LIMIT 1').first<Event>();
  if (!event || !canContinue()) return;
  const discard = () => db.prepare('DELETE FROM wake_message_outbox WHERE seq = ? AND owner_after = ?').bind(event.seq, event.owner_after).run();
  const now = Date.now();
  if (!Number.isSafeInteger(event.stored_at) || event.stored_at > now) { await discard(); return; }
  if (now - event.stored_at > STATE_LIMITS.queuedMs) {
    // Recover from an offline sender without spending one poll per stale event.
    // Inspect at most the first 100 rows, deleting only already-expired hints.
    await db.prepare(`DELETE FROM wake_message_outbox WHERE seq IN
      (SELECT seq FROM wake_message_outbox ORDER BY seq LIMIT 100) AND stored_at < ?`).bind(now - STATE_LIMITS.queuedMs).run();
    return;
  }
  // Bound data before it crosses into JS. Oversized messages remain readable in
  // the ledger but do not create wake work in this rollout.
  const row = await db.prepare(`SELECT id, channel, sender, type, sequence, stored_seq, timestamp, payload_json, signature, checksum, encrypted
    FROM messages WHERE id = ? AND length(CAST(payload_json AS BLOB)) <= 65536`).bind(event.envelope_id).first<RecordRow>();
  if (!row) { await discard(); return; }
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { await discard(); return; }
  const record: StoredEnvelope = { id: row.id, channel: row.channel, sender: row.sender, type: row.type, sequence: row.sequence,
    storedSeq: row.stored_seq, timestamp: row.timestamp, payload, signature: row.signature, checksum: row.checksum, encrypted: row.encrypted === 1 };
  if (!canContinue()) return;
  const owners = (await db.prepare(`SELECT agent_id FROM wake_hook_state
    WHERE agent_id > ? AND agent_id <= ? AND due_at IS NOT NULL ORDER BY agent_id LIMIT 5`)
    .bind(event.owner_after, event.owner_until).all<{ agent_id: string }>()).results;
  for (const { agent_id } of owners) {
    if (!canContinue()) return;
    try { await manager.enqueue(agent_id, record, event.stored_at); }
    catch {
      // Hints are best-effort: a corrupt owner must not block every later owner.
      // No raw SQL/crypto errors, envelopes or receiver secrets go into logs.
      console.warn(JSON.stringify({ event: 'wake_fanout_owner_skipped' }));
    }
    const advanced = await db.prepare('UPDATE wake_message_outbox SET owner_after = ? WHERE seq = ? AND owner_after = ?')
      .bind(agent_id, event.seq, event.owner_after).run();
    if (advanced.meta.changes !== 1) return; // another poll progressed/pruned it
    event.owner_after = agent_id;
  }
  if (owners.length < 5) await discard();
}
