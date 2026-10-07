import type { StoredEnvelope } from '@openagentforum/protocol';
import { storedEnvelope, type EnvelopeRow } from './envelopes.js';

/** Hosted work policy, separate from the offline protocol's tally rules. */
export const POLL_WORK_LIMITS = Object.freeze({
  records: 1024, bytes: 4 * 1024 * 1024, recordBytes: 263168,
  nodes: 65536, recordNodes: 8192, depth: 16, entries: 1024,
  propertyLength: 256, memoryScans: 10000, list: 50,
});

export class PollWorkError extends Error {
  constructor(readonly code: 'poll_work_limit' | 'poll_work_unavailable' | 'invalid_poll_query') { super(code); }
  response(): Response {
    return Response.json({ error: this.code, code: this.code }, {
      status: this.code === 'invalid_poll_query' ? 400 : 503,
      headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    });
  }
}
const limit = (): never => { throw new PollWorkError('poll_work_limit'); };
const unavailable = (): never => { throw new PollWorkError('poll_work_unavailable'); };
export function pollIdentifier(value: unknown, max = 256): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) {
    throw new PollWorkError('invalid_poll_query');
  }
}

export interface PollStore {
  getPoll(channel: string | undefined, pollId: string): Promise<StoredEnvelope | null>;
  candidates(channel: string, pollId: string, atSeq?: number): Promise<StoredEnvelope[]>;
  listPolls(channel?: string): Promise<StoredEnvelope[]>;
  publicKey(agentId: string): Promise<string | null>;
  registeredAt(agentId: string): Promise<number | null>;
  active(): void;
}

class Work {
  records = 0; bytes = 0; nodes = 0; scans = 0;
  constructor(private signal?: AbortSignal) {}
  active() { if (this.signal?.aborted) unavailable(); }
  charge(records: number, bytes: number, largest: number) {
    this.active();
    if (records > POLL_WORK_LIMITS.records - this.records || bytes > POLL_WORK_LIMITS.bytes - this.bytes || largest > POLL_WORK_LIMITS.recordBytes) limit();
    this.records += records; this.bytes += bytes;
  }
  scan() { this.active(); if (++this.scans > POLL_WORK_LIMITS.memoryScans) limit(); }
  tree(value: unknown) {
    const pending: [unknown, number][] = [[value, 0]];
    let nodes = 0, stringUnits = 0;
    while (pending.length) {
      const [v, depth] = pending.pop()!;
      if (++nodes > POLL_WORK_LIMITS.recordNodes || ++this.nodes > POLL_WORK_LIMITS.nodes || depth > POLL_WORK_LIMITS.depth) limit();
      if (typeof v === 'string') stringUnits += v.length;
      else if (v && typeof v === 'object') {
        const keys = Object.keys(v);
        if (keys.length > POLL_WORK_LIMITS.entries || nodes + pending.length + keys.length > POLL_WORK_LIMITS.recordNodes) limit();
        for (const key of keys) {
          if (key.length > POLL_WORK_LIMITS.propertyLength) limit();
          stringUnits += key.length;
          pending.push([(v as Record<string, unknown>)[key], depth + 1]);
        }
      }
      if (stringUnits > POLL_WORK_LIMITS.recordBytes) limit();
    }
  }
  parse(raw: string): unknown {
    // Bound nesting before JSON.parse and before recursive canonicalization.
    let depth = 0, quoted = false, escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') { if (++depth > POLL_WORK_LIMITS.depth) limit(); }
      else if (c === '}' || c === ']') depth--;
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return unavailable(); }
    this.tree(value);
    return value;
  }
}

const reference = "(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pollId') END)";
const open = "type = 'poll' AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.kind') END) = 'open'";
export const POLL_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_messages_poll_reference ON messages(channel, ${reference}, COALESCE(stored_seq, sequence), id) WHERE type IN ('vote','poll');
CREATE INDEX IF NOT EXISTS idx_messages_poll_open_channel ON messages(channel, COALESCE(stored_seq, sequence) DESC, id DESC) WHERE ${open};
CREATE INDEX IF NOT EXISTS idx_messages_poll_open ON messages(COALESCE(stored_seq, sequence) DESC, id DESC) WHERE ${open};
`;
const wireColumns = ['id', 'channel', 'sender', 'type', 'sequence', 'stored_seq', 'timestamp', 'payload_json',
  'signature', 'checksum', 'encrypted', 'reply_to_id', 'recipient_keys_json', 'ephemeral_public_key', 'nonce'];
// Fixed overhead includes scalar fields, JSON framing and the bounded registry join.
// Count even numeric-affinity columns: SQLite can retain legacy text in them.
const byteCost = '512 + ' + wireColumns.map(c => `COALESCE(length(CAST(${c} AS BLOB)), 0)`).join(' + ');
const registryColumns = "CASE WHEN length(CAST(a.public_key AS BLOB)) <= 128 THEN a.public_key END AS public_key, CASE WHEN typeof(a.registered_at) = 'integer' THEN a.registered_at END AS registered_at";
type Row = Record<string, unknown>;
type Agent = { publicKey: string | null; registeredAt: number | null };

/** One instance per HTTP operation; query must read one primary SQL snapshot. */
export function createSqlPollStore(query: (sql: string, args: (string | number)[]) => Promise<Row[]>, signal?: AbortSignal): PollStore {
  const work = new Work(signal), agents = new Map<string, Agent>();
  async function read(sql: string, args: (string | number)[]) {
    work.active();
    let rows: Row[];
    try { rows = await query(sql, args); } catch { return unavailable(); }
    work.active();
    if (!Array.isArray(rows)) return unavailable();
    return rows;
  }
  function remember(row: Row) {
    const value = { publicKey: typeof row.public_key === 'string' ? row.public_key : null,
      registeredAt: typeof row.registered_at === 'number' ? row.registered_at : null };
    agents.set(String(row.sender), value);
    return value;
  }
  async function select(where: string, args: (string | number)[], index: string, order: string, take: number) {
    const remaining = POLL_WORK_LIMITS.records - work.records;
    // Only rowids and byte counts enter picked. If any bound fails, the LEFT
    // JOIN emits a metadata-only sentinel; oversized payloads never leave SQL.
    const rows = await read(`WITH picked AS MATERIALIZED (
      SELECT rowid AS rid, ${byteCost} AS bytes FROM messages ${index}
      WHERE ${where} ORDER BY ${order} LIMIT ?
    ), bounds AS MATERIALIZED (
      SELECT count(*) AS total_records, COALESCE(sum(bytes), 0) AS total_bytes, COALESCE(max(bytes), 0) AS max_bytes FROM picked
    ) SELECT b.total_records, b.total_bytes, b.max_bytes, ${wireColumns.map(c => `m.${c}`).join(', ')}, ${registryColumns}
      FROM bounds b
      LEFT JOIN picked p ON b.total_records <= ? AND b.total_bytes <= ? AND b.max_bytes <= ?
      LEFT JOIN messages m ON m.rowid = p.rid
      LEFT JOIN agents a ON a.agent_id = m.sender
      ORDER BY COALESCE(m.stored_seq, m.sequence), m.id`,
    [...args, take, remaining, POLL_WORK_LIMITS.bytes - work.bytes, POLL_WORK_LIMITS.recordBytes]);
    const first = rows[0];
    if (!first) return unavailable();
    const { total_records: n, total_bytes: bytes, max_bytes: max } = first;
    if (![n, bytes, max].every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) return unavailable();
    work.charge(n as number, bytes as number, max as number);
    if (n === 0) { if (rows.length !== 1 || first.id !== null) return unavailable(); return []; }
    if (rows.length !== n) return unavailable();
    return rows.map(row => {
      if (typeof row.payload_json !== 'string' || typeof row.id !== 'string' || row.total_records !== n || row.total_bytes !== bytes || row.max_bytes !== max) return unavailable();
      const payload = work.parse(row.payload_json);
      const recipientKeys = row.recipient_keys_json == null ? undefined : work.parse(String(row.recipient_keys_json));
      remember(row);
      // Preserve all signed fields and transport metadata. Parsing is bounded
      // above; do not normalize or re-sign durable payloads.
      return { ...storedEnvelope({ ...row, payload_json: 'null', recipient_keys_json: null } as unknown as EnvelopeRow), payload, recipientKeys } as StoredEnvelope;
    });
  }
  return {
    active: () => work.active(),
    async getPoll(channel, pollId) {
      pollIdentifier(pollId); if (channel !== undefined) pollIdentifier(channel, 128);
      return (await select("id = ? AND type = 'poll'" + (channel === undefined ? '' : ' AND channel = ?'),
        channel === undefined ? [pollId] : [pollId, channel], '', 'rowid', 1))[0] ?? null;
    },
    async candidates(channel, pollId, atSeq) {
      pollIdentifier(channel, 128); pollIdentifier(pollId);
      if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) throw new PollWorkError('invalid_poll_query');
      return select(`channel = ? AND ${reference} = ? AND type IN ('vote','poll')${atSeq === undefined ? '' : ' AND COALESCE(stored_seq, sequence) <= ?'}`,
        atSeq === undefined ? [channel, pollId] : [channel, pollId, atSeq], 'INDEXED BY idx_messages_poll_reference',
        'COALESCE(stored_seq, sequence), id', POLL_WORK_LIMITS.records - work.records + 1);
    },
    async listPolls(channel) {
      if (channel !== undefined) pollIdentifier(channel, 128);
      return (await select(open + (channel === undefined ? '' : ' AND channel = ?'), channel === undefined ? [] : [channel],
        `INDEXED BY idx_messages_poll_open${channel === undefined ? '' : '_channel'}`, 'COALESCE(stored_seq, sequence) DESC, id DESC', POLL_WORK_LIMITS.list)).reverse();
    },
    async publicKey(agentId) { work.active(); return agents.get(agentId)?.publicKey ?? null; },
    async registeredAt(agentId) {
      work.active();
      if (!agents.has(agentId)) {
        pollIdentifier(agentId);
        const rows = await read(`SELECT ? AS sender, ${registryColumns} FROM agents a WHERE a.agent_id = ?`, [agentId, agentId]);
        if (rows.length > 1) return unavailable();
        remember(rows[0] ?? { sender: agentId });
      }
      return agents.get(agentId)?.registeredAt ?? null;
    },
  };
}

/** Structural public types keep the published package independent of Workers types. */
export interface PollD1Database {
  withSession(constraint: 'first-primary'): {
    prepare(sql: string): { bind(...args: unknown[]): { all<T = Row>(): Promise<{ success: boolean; results: T[] }> } };
  };
}
export function createD1PollStore(db: PollD1Database, signal?: AbortSignal): PollStore {
  return createSqlPollStore(async (sql, args) => {
    const result = await db.withSession('first-primary').prepare(sql).bind(...args).all<Row>();
    if (!result.success) return unavailable();
    return result.results;
  }, signal);
}

/** Development fallback only; bounded source scans, with no D1 failure fallback. */
export function createMemoryPollStore(records: () => Iterable<StoredEnvelope>, agent: (id: string) => Agent | undefined, signal?: AbortSignal): PollStore {
  const work = new Work(signal), encoder = new TextEncoder();
  function retain(rows: StoredEnvelope[]) {
    for (const row of rows) {
      work.tree(row);
      const bytes = encoder.encode(JSON.stringify(row)).byteLength + 512;
      work.charge(1, bytes, bytes);
    }
    return rows;
  }
  const position = (row: StoredEnvelope) => row.storedSeq ?? row.sequence;
  return {
    active: () => work.active(),
    async getPoll(channel, pollId) {
      pollIdentifier(pollId); if (channel !== undefined) pollIdentifier(channel, 128);
      for (const row of records()) {
        work.scan();
        if (row.id === pollId && row.type === 'poll' && (channel === undefined || row.channel === channel)) return retain([row])[0];
      }
      return null;
    },
    async candidates(channel, pollId, atSeq) {
      pollIdentifier(channel, 128); pollIdentifier(pollId);
      if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) throw new PollWorkError('invalid_poll_query');
      const out: StoredEnvelope[] = [];
      for (const row of records()) {
        work.scan();
        if (row.channel === channel && (row.type === 'vote' || row.type === 'poll') &&
            row.payload?.pollId === pollId && (atSeq === undefined || position(row) <= atSeq)) {
          retain([row]); out.push(row);
        }
      }
      return out.sort((a, b) => position(a) - position(b));
    },
    async listPolls(channel) {
      if (channel !== undefined) pollIdentifier(channel, 128);
      const out: StoredEnvelope[] = [];
      for (const row of records()) {
        work.scan();
        if ((channel === undefined || row.channel === channel) && row.type === 'poll' && row.payload?.kind === 'open') {
          out.push(row); out.sort((a, b) => position(b) - position(a));
          if (out.length > POLL_WORK_LIMITS.list) out.pop();
        }
      }
      return retain(out);
    },
    async publicKey(id) { work.active(); const key = agent(id)?.publicKey; return key && key.length <= 128 ? key : null; },
    async registeredAt(id) { work.active(); return agent(id)?.registeredAt ?? null; },
  };
}
