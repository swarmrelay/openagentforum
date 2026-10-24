/** Local, bounded exact-operation journal. Caller owns a dedicated private WAL
 * database outside the checkout. No signer, key custody, network or auto-retry. */
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@openagentforum/protocol';
import { assertSqliteWalRuntime } from '../../server/dist/sqlite-runtime.js';
import { bytes, messageIdentifier, tree, parseWire, type Receipt } from './contract.js';
import { HTTP_WIRE_BYTES } from './http-contract.js';
import { PollHttpClient, pollReceiptMatches, type PollHttpClientOptions, type PendingPollOperation, type PollOperationJournal } from './http-client.js';

export interface PollJournalOptions extends Pick<PollHttpClientOptions, 'origin' | 'generation' | 'policyRevision' | 'actorKey'> {
  maxOperations: number; maxBytes: number;
}
export class PollJournalError extends Error {
  constructor(readonly code: 'configuration' | 'capacity' | 'conflict' | 'unavailable') { super(`Poll journal: ${code}`); }
  readonly permitsReplacementMutation = false;
}
const TABLES = [
  'CREATE TABLE poll_client_authority (id INTEGER PRIMARY KEY CHECK(id = 1), config TEXT NOT NULL)',
  'CREATE TABLE poll_client_operations (id TEXT PRIMARY KEY, operation_json TEXT NOT NULL CHECK(length(CAST(operation_json AS BLOB)) <= 1048576), receipt_json TEXT CHECK(receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= 4096))',
];
function limit(ok: unknown, code: ConstructorParameters<typeof PollJournalError>[0]): asserts ok {
  if (!ok) throw new PollJournalError(code);
}
function configured(options: PollJournalOptions) {
  // Reuse transport pin validation without making requests.
  new PollHttpClient(options);
  limit(Number.isSafeInteger(options.maxOperations) && options.maxOperations > 0 && options.maxOperations <= 512
    && Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 4096 && options.maxBytes <= 16 * 1024 * 1024, 'configuration');
  const { origin, generation, policyRevision, actorKey, maxOperations, maxBytes } = options;
  return { origin, generation, policyRevision, actorKey, maxOperations, maxBytes };
}
function schema(db: DatabaseSync, empty = false) {
  limit(db.prepare('PRAGMA journal_mode').get()?.journal_mode === 'wal'
    && db.prepare('PRAGMA synchronous').get()?.synchronous === 2
    && db.prepare('PRAGMA ignore_check_constraints').get()?.ignore_check_constraints === 0
    && Number(db.prepare('PRAGMA busy_timeout').get()?.timeout) <= 1000, 'unavailable');
  const objects = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 4").all();
  limit(empty ? objects.length === 0 : objects.length === 2 && objects.every((o, i) => o.sql === TABLES[i]), 'unavailable');
  limit(db.prepare('SELECT name FROM sqlite_temp_master LIMIT 1').all().length === 0
    && db.prepare('PRAGMA database_list').all().every(row => row.name === 'main' || row.name === 'temp'), 'unavailable');
}

/** Explicit empty-database setup only; never called by a write/recovery/client constructor. */
export function provisionPollJournal(db: DatabaseSync, options: PollJournalOptions) {
  const config = configured(options); assertSqliteWalRuntime(db);
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true;
    schema(db, true);
    for (const sql of TABLES) db.exec(sql);
    db.prepare('INSERT INTO poll_client_authority VALUES (1, ?)').run(canonicalizeJson(config));
    db.exec('COMMIT');
  } catch {
    if (begun) { try { db.exec('ROLLBACK'); } catch { /* Never claim absence after uncertain commit. */ } }
    throw new PollJournalError('unavailable');
  }
}

export class SQLitePollJournal implements PollOperationJournal {
  readonly #config: PollJournalOptions;
  readonly #configJson: string;
  #poisoned = false;
  constructor(readonly db: DatabaseSync, options: PollJournalOptions) {
    this.#config = configured(options); this.#configJson = canonicalizeJson(this.#config);
    assertSqliteWalRuntime(db);
    this.#transaction(false, () => {});
  }
  #transaction<T>(write: boolean, operation: () => T): T {
    limit(!this.#poisoned, 'unavailable');
    let begun = false, committing = false;
    try {
      this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
      schema(this.db);
      limit(this.db.prepare('SELECT config FROM poll_client_authority WHERE id = 1').get()?.config === this.#configJson, 'unavailable');
      const usage = this.db.prepare('SELECT count(*) AS records, coalesce(sum(length(CAST(operation_json AS BLOB)) + 4096), 0) AS bytes FROM poll_client_operations').get();
      limit(usage && Number(usage.records) <= this.#config.maxOperations && Number(usage.bytes) <= this.#config.maxBytes, 'unavailable');
      const result = operation(); committing = true;
      this.db.exec('COMMIT'); begun = false; return result;
    } catch (failure) {
      if (begun) { try { this.db.exec('ROLLBACK'); } catch { this.#poisoned = true; } }
      if (!committing && !this.#poisoned && failure instanceof PollJournalError && failure.code !== 'unavailable') throw failure;
      this.#poisoned = true; throw new PollJournalError('unavailable');
    }
  }
  #encode(operation: PendingPollOperation): string {
    tree(operation);
    const encoded = canonicalizeJson(operation), c = this.#config;
    limit(bytes(encoded) <= 1048576 && messageIdentifier(operation.id) && typeof operation.wire === 'string'
      && operation.origin === c.origin && operation.generation === c.generation
      && operation.policyRevision === c.policyRevision && operation.actorKey === c.actorKey, 'conflict');
    const env = parseWire(operation.wire, { wireBytes: HTTP_WIRE_BYTES });
    const route = env.type === 'poll' && env.payload?.kind === 'close'
      ? { operation: 'close', channel: env.channel, pollId: env.payload.pollId } : { operation: 'write', channel: env.channel };
    limit(env.id === operation.id && env.sender === `agent_${createHash('sha256').update(c.actorKey).digest('hex').slice(0, 16)}`
      && canonicalizeJson(operation.route) === canonicalizeJson(route)
      && Object.keys(operation).sort().join(',') === 'actorKey,generation,id,origin,policyRevision,route,wire', 'conflict');
    return encoded;
  }
  async retain(operation: PendingPollOperation): Promise<void> {
    const encoded = this.#encode(operation), cost = bytes(encoded) + 4096;
    this.#transaction(true, () => {
      const previous = this.db.prepare('SELECT operation_json FROM poll_client_operations WHERE id = ?').get(operation.id);
      if (previous) { limit(previous.operation_json === encoded, 'conflict'); return; }
      const usage = this.db.prepare('SELECT count(*) AS records, coalesce(sum(length(CAST(operation_json AS BLOB)) + 4096), 0) AS bytes FROM poll_client_operations').get()!;
      limit(Number(usage.records) < this.#config.maxOperations && Number(usage.bytes) + cost <= this.#config.maxBytes, 'capacity');
      limit(this.db.prepare('INSERT INTO poll_client_operations VALUES (?, ?, NULL)').run(operation.id, encoded).changes === 1, 'unavailable');
    });
  }
  async acknowledge(operation: PendingPollOperation, receipt: Receipt): Promise<void> {
    const encoded = this.#encode(operation); tree(receipt);
    const saved = canonicalizeJson(receipt);
    limit(bytes(saved) <= 4096 && pollReceiptMatches(receipt, parseWire(operation.wire, { wireBytes: HTTP_WIRE_BYTES }), this.#config), 'conflict');
    this.#transaction(true, () => {
      const previous = this.db.prepare('SELECT operation_json, receipt_json FROM poll_client_operations WHERE id = ?').get(operation.id);
      limit(previous?.operation_json === encoded, 'conflict');
      if (previous.receipt_json !== null) { limit(previous.receipt_json === saved, 'conflict'); return; }
      limit(this.db.prepare('UPDATE poll_client_operations SET receipt_json = ? WHERE id = ? AND receipt_json IS NULL').run(saved, operation.id).changes === 1, 'unavailable');
    });
  }
  /** Reading a retained operation performs no network request or replacement. */
  get(id: string): { operation: PendingPollOperation; receipt: Receipt | null } | null {
    limit(messageIdentifier(id), 'conflict');
    return this.#transaction(false, () => {
      const row = this.db.prepare('SELECT operation_json, receipt_json FROM poll_client_operations WHERE id = ?').get(id);
      if (!row) return null;
      limit(typeof row.operation_json === 'string' && bytes(row.operation_json) <= 1048576, 'unavailable');
      const operation = JSON.parse(row.operation_json) as PendingPollOperation;
      limit(operation.id === id && this.#encode(operation) === row.operation_json, 'unavailable');
      limit(row.receipt_json === null || typeof row.receipt_json === 'string' && bytes(row.receipt_json) <= 4096, 'unavailable');
      const receipt = row.receipt_json === null ? null : JSON.parse(row.receipt_json as string) as Receipt;
      if (row.receipt_json !== null) limit(pollReceiptMatches(receipt, parseWire(operation.wire, { wireBytes: HTTP_WIRE_BYTES }), this.#config)
        && canonicalizeJson(receipt) === row.receipt_json, 'unavailable');
      return { operation, receipt };
    });
  }
}
