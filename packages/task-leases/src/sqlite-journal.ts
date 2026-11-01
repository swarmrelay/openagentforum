/** Source-only exact-operation journal. The caller owns a dedicated private WAL
 * database outside the checkout. No signer, key custody, network or automatic retry. */
import type { DatabaseSync } from 'node:sqlite';
import { canonicalizeJson } from '@openagentforum/protocol';
import { assertSqliteWalRuntime } from '../../server/dist/sqlite-runtime.js';
import { LIMITS, bounded, bytes, hex, verifyWire, type Proof, type Receipt } from './contract.js';
import { fields, sameScope, scope, type Scope } from './http-contract.js';
import { receiptMatches, type PendingTaskLeaseOperation, type TaskLeaseOperationJournal } from './http-client.js';

export interface TaskLeaseJournalOptions extends Scope { actorKey: string; maxOperations: number; maxBytes: number }
export class TaskLeaseJournalError extends Error {
  readonly permitsReplacementMutation = false;
  constructor(readonly code: 'configuration' | 'capacity' | 'conflict' | 'busy' | 'unavailable') { super(`Task lease journal: ${code}`); }
}
// A canonical wire can double in size when nested as a JSON string. Every claim
// permanently allocates this maximum plus a receipt for exactly one completion.
export const TASK_JOURNAL_OPERATION_BYTES = LIMITS.wireBytes * 2 + 4096;
export const TASK_JOURNAL_COMPLETION_BYTES = TASK_JOURNAL_OPERATION_BYTES + LIMITS.receiptBytes;
const SCHEMA = [
  'CREATE TABLE task_client_authority (id INTEGER PRIMARY KEY CHECK(id = 1), config TEXT NOT NULL) STRICT',
  `CREATE TABLE task_client_operations (id TEXT PRIMARY KEY, operation_json TEXT NOT NULL CHECK(length(CAST(operation_json AS BLOB)) <= ${TASK_JOURNAL_OPERATION_BYTES}), receipt_json TEXT CHECK(receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= ${LIMITS.receiptBytes}), completion_for TEXT UNIQUE REFERENCES task_client_operations(id)) STRICT`,
  'CREATE TABLE task_client_completion (claim_id TEXT PRIMARY KEY REFERENCES task_client_operations(id), terminal_id TEXT UNIQUE REFERENCES task_client_operations(id)) STRICT',
];
const SORTED_SCHEMA = [SCHEMA[0], SCHEMA[2], SCHEMA[1]];
type Saved = { operation_json: string; receipt_json: string | null };
function requireJournal(ok: unknown, code: TaskLeaseJournalError['code']): asserts ok { if (!ok) throw new TaskLeaseJournalError(code); }
function configuration(options: TaskLeaseJournalOptions) {
  try {
    const pinned = scope(options), { actorKey, maxOperations, maxBytes } = options;
    requireJournal(hex(actorKey, 64) && Number.isSafeInteger(maxOperations) && maxOperations > 0 && maxOperations <= 512
      && Number.isSafeInteger(maxBytes) && maxBytes >= LIMITS.receiptBytes && maxBytes <= 32 * 1024 * 1024, 'configuration');
    return { ...pinned, actorKey, maxOperations, maxBytes };
  } catch { throw new TaskLeaseJournalError('configuration'); }
}
function schema(db: DatabaseSync, empty = false) {
  requireJournal(db.prepare('PRAGMA journal_mode').get()?.journal_mode === 'wal'
    && db.prepare('PRAGMA synchronous').get()?.synchronous === 2
    && db.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1
    && db.prepare('PRAGMA ignore_check_constraints').get()?.ignore_check_constraints === 0
    && Number(db.prepare('PRAGMA busy_timeout').get()?.timeout) <= 1000, 'unavailable');
  const installed = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 4").all();
  requireJournal(empty ? installed.length === 0 : installed.length === 3 && installed.every((row, i) => row.sql === SORTED_SCHEMA[i]), 'unavailable');
  requireJournal(db.prepare('SELECT name FROM sqlite_temp_master LIMIT 1').all().length === 0
    && db.prepare('PRAGMA database_list').all().every(row => row.name === 'main' || row.name === 'temp'), 'unavailable');
}

/** Explicit empty-database setup, never invoked by a client or recovery method. */
export function provisionTaskLeaseJournal(db: DatabaseSync, options: TaskLeaseJournalOptions): void {
  const config = configuration(options); assertSqliteWalRuntime(db);
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true; schema(db, true);
    for (const sql of SCHEMA) db.exec(sql);
    db.prepare('INSERT INTO task_client_authority VALUES (1, ?)').run(canonicalizeJson(config));
    db.exec('COMMIT');
  } catch {
    if (begun) { try { db.exec('ROLLBACK'); } catch { /* Never infer absence from an uncertain commit. */ } }
    throw new TaskLeaseJournalError('unavailable');
  }
}

export class SQLiteTaskLeaseJournal implements TaskLeaseOperationJournal {
  readonly #config: TaskLeaseJournalOptions;
  readonly #configJson: string;
  #poisoned = false;
  #busy = false;
  constructor(readonly db: DatabaseSync, options: TaskLeaseJournalOptions) {
    this.#config = configuration(options); this.#configJson = canonicalizeJson(this.#config);
    assertSqliteWalRuntime(db); this.#transaction(false, () => {});
  }
  #usage() {
    // These arrays are bounded even if an external writer corrupted the journal.
    const operations = this.db.prepare(`SELECT id, completion_for, length(CAST(operation_json AS BLOB)) AS size,
      json_extract(json_extract(operation_json, '$.wire'), '$.command.action') AS action
      FROM task_client_operations LIMIT ?`).all(this.#config.maxOperations + 1);
    const reservations = this.db.prepare('SELECT claim_id, terminal_id FROM task_client_completion LIMIT ?').all(this.#config.maxOperations + 1);
    requireJournal(operations.length <= this.#config.maxOperations && reservations.length <= this.#config.maxOperations, 'unavailable');
    const byId = new Map(operations.map(row => [row.id, row]));
    const byClaim = new Map(reservations.map(row => [row.claim_id, row]));
    let count = operations.length, total = reservations.length * TASK_JOURNAL_COMPLETION_BYTES;
    for (const row of operations) {
      requireJournal(typeof row.size === 'number' && row.size > 0 && row.size <= TASK_JOURNAL_OPERATION_BYTES, 'unavailable');
      if (row.completion_for === null) {
        requireJournal(['create', 'claim', 'reopen'].includes(String(row.action)), 'unavailable');
        requireJournal((row.action === 'claim') === byClaim.has(row.id), 'unavailable');
        total += row.size + LIMITS.receiptBytes;
      } else {
        requireJournal(['submit', 'release'].includes(String(row.action)) && byClaim.get(row.completion_for)?.terminal_id === row.id, 'unavailable');
      }
    }
    for (const row of reservations) {
      requireJournal(byId.get(row.claim_id)?.action === 'claim', 'unavailable');
      if (row.terminal_id === null) count++;
      else requireJournal(byId.get(row.terminal_id)?.completion_for === row.claim_id, 'unavailable');
    }
    requireJournal(count <= this.#config.maxOperations && total <= this.#config.maxBytes, 'unavailable');
    return { count, bytes: total };
  }
  #transaction<T>(write: boolean, operation: () => T): T {
    requireJournal(!this.#poisoned, 'unavailable');
    let begun = false, committing = false;
    try {
      this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true; schema(this.db);
      requireJournal(this.db.prepare('SELECT config FROM task_client_authority WHERE id = 1').get()?.config === this.#configJson, 'unavailable');
      this.#usage();
      const result = operation(); this.#usage(); committing = true;
      this.db.exec('COMMIT'); begun = false; return result;
    } catch (failure) {
      if (begun) { try { this.db.exec('ROLLBACK'); } catch { this.#poisoned = true; } }
      if (!committing && !this.#poisoned && failure instanceof TaskLeaseJournalError && failure.code !== 'unavailable') throw failure;
      this.#poisoned = true; throw new TaskLeaseJournalError('unavailable');
    }
  }
  async #run<T>(work: () => Promise<T>): Promise<T> {
    requireJournal(!this.#poisoned, 'unavailable'); requireJournal(!this.#busy, 'busy'); this.#busy = true;
    try { return await work(); }
    catch (failure) {
      if (failure instanceof TaskLeaseJournalError && failure.code !== 'unavailable') throw failure;
      this.#poisoned = true; throw new TaskLeaseJournalError('unavailable');
    } finally { this.#busy = false; }
  }
  async #validate(operation: PendingTaskLeaseOperation) {
    try {
      requireJournal(fields(operation, ['origin', 'audience', 'generation', 'policyRevision', 'actorKey', 'operationId', 'taskId', 'commandDigest', 'wire'])
        && sameScope({ origin: operation.origin, audience: operation.audience, generation: operation.generation,
          policyRevision: operation.policyRevision }, scope(this.#config))
        && operation.actorKey === this.#config.actorKey && hex(operation.operationId, 32)
        && typeof operation.wire === 'string' && operation.wire.length <= LIMITS.wireBytes
        && typeof operation.taskId === 'string' && operation.taskId.length === 69 && hex(operation.commandDigest, 64), 'conflict');
      const encoded = canonicalizeJson(operation);
      requireJournal(bytes(encoded) <= TASK_JOURNAL_OPERATION_BYTES, 'conflict');
      const snapshot = JSON.parse(encoded) as PendingTaskLeaseOperation;
      const proof = await verifyWire(snapshot.wire);
      requireJournal(proof.command.action !== 'receipt' && proof.command.actorKey === snapshot.actorKey
        && proof.command.audience === snapshot.audience && proof.command.operationId === snapshot.operationId
        && proof.taskId === snapshot.taskId && proof.digest === snapshot.commandDigest, 'conflict');
      return { operation: snapshot, encoded, proof };
    } catch { throw new TaskLeaseJournalError('conflict'); }
  }
  #row(id: string): Saved | undefined {
    const row = this.db.prepare('SELECT operation_json, receipt_json FROM task_client_operations WHERE id = ?').get(id);
    if (!row) return undefined;
    requireJournal(typeof row.operation_json === 'string' && bytes(row.operation_json) <= TASK_JOURNAL_OPERATION_BYTES
      && (row.receipt_json === null || typeof row.receipt_json === 'string' && bytes(row.receipt_json) <= LIMITS.receiptBytes), 'unavailable');
    return row as Saved;
  }
  #receipt(row: Saved, proof: Proof): Receipt | null {
    const receipt: Receipt | null = row.receipt_json === null ? null : JSON.parse(row.receipt_json);
    if (row.receipt_json !== null) requireJournal(receipt !== null && canonicalizeJson(receipt) === row.receipt_json
      && receiptMatches(receipt, proof), 'unavailable');
    return receipt;
  }
  async #saved(row: Saved) {
    try {
      const validated = await this.#validate(JSON.parse(row.operation_json));
      requireJournal(validated.encoded === row.operation_json, 'unavailable');
      const receipt = this.#receipt(row, validated.proof);
      return { ...validated, receipt };
    } catch { throw new TaskLeaseJournalError('unavailable'); }
  }
  async retain(input: PendingTaskLeaseOperation): Promise<void> {
    return this.#run(async () => {
      const { operation, encoded, proof } = await this.#validate(input);
      if (this.#transaction(false, () => {
        const previous = this.#row(operation.operationId);
        if (!previous) return false;
        requireJournal(previous.operation_json === encoded, 'conflict'); this.#receipt(previous, proof); return true;
      })) return;
      const terminal = proof.command.action === 'submit' || proof.command.action === 'release';
      let claim: { id: string; saved: Saved } | undefined;
      if (terminal) {
        const command = proof.command;
        requireJournal(command.action === 'submit' || command.action === 'release', 'conflict');
        claim = this.#transaction(false, () => {
          const rows = this.db.prepare(`SELECT o.id FROM task_client_completion c JOIN task_client_operations o ON o.id = c.claim_id
            WHERE json_extract(o.receipt_json, '$.taskId') = ? AND json_extract(o.receipt_json, '$.generation') = ?
              AND json_extract(o.receipt_json, '$.revision') = ? LIMIT 2`)
            .all(operation.taskId, command.payload.generation, command.expectedRevision);
          requireJournal(rows.length === 1 && typeof rows[0].id === 'string', 'conflict');
          return { id: rows[0].id, saved: this.#row(rows[0].id)! };
        });
        const original = await this.#saved(claim.saved);
        requireJournal(original.proof.command.action === 'claim' && original.receipt !== null
          && original.receipt.taskId === operation.taskId && original.receipt.generation === command.payload.generation
          && original.receipt.revision === command.expectedRevision, 'conflict');
      }
      this.#transaction(true, () => {
        const previous = this.#row(operation.operationId);
        if (previous) { requireJournal(previous.operation_json === encoded, 'conflict'); this.#receipt(previous, proof); return; }
        requireJournal(!this.db.prepare(`SELECT id FROM task_client_operations WHERE receipt_json IS NULL
          AND json_extract(operation_json, '$.taskId') = ? LIMIT 1`).get(operation.taskId), 'conflict');
        if (claim) {
          const current = this.#row(claim.id);
          requireJournal(current?.operation_json === claim.saved.operation_json && current.receipt_json === claim.saved.receipt_json, 'unavailable');
          requireJournal(this.db.prepare('SELECT terminal_id FROM task_client_completion WHERE claim_id = ?').get(claim.id)?.terminal_id === null, 'conflict');
        } else {
          const usage = this.#usage(), reserve = proof.command.action === 'claim';
          requireJournal(usage.count + (reserve ? 2 : 1) <= this.#config.maxOperations
            && usage.bytes + bytes(encoded) + LIMITS.receiptBytes + (reserve ? TASK_JOURNAL_COMPLETION_BYTES : 0) <= this.#config.maxBytes, 'capacity');
        }
        requireJournal(this.db.prepare('INSERT INTO task_client_operations VALUES (?, ?, NULL, ?)')
          .run(operation.operationId, encoded, claim?.id ?? null).changes === 1, 'unavailable');
        if (claim) requireJournal(this.db.prepare('UPDATE task_client_completion SET terminal_id = ? WHERE claim_id = ? AND terminal_id IS NULL')
          .run(operation.operationId, claim.id).changes === 1, 'unavailable');
        if (proof.command.action === 'claim') requireJournal(this.db.prepare('INSERT INTO task_client_completion VALUES (?, NULL)').run(operation.operationId).changes === 1, 'unavailable');
      });
    });
  }
  async acknowledge(input: PendingTaskLeaseOperation, value: Receipt): Promise<void> {
    return this.#run(async () => {
      // Snapshot the receipt before verification awaits, just as #validate snapshots the operation.
      let encodedReceipt: string;
      try { bounded(value); requireJournal(value !== null && typeof value === 'object'
        && Object.values(value).every(v => typeof v !== 'string' || v.length <= LIMITS.receiptBytes), 'conflict');
        encodedReceipt = canonicalizeJson(value);
        requireJournal(bytes(encodedReceipt) <= LIMITS.receiptBytes, 'conflict'); }
      catch { throw new TaskLeaseJournalError('conflict'); }
      const { operation, encoded, proof } = await this.#validate(input);
      requireJournal(receiptMatches(JSON.parse(encodedReceipt), proof), 'conflict');
      this.#transaction(true, () => {
        const previous = this.#row(operation.operationId);
        requireJournal(previous?.operation_json === encoded, 'conflict');
        if (previous.receipt_json !== null) { requireJournal(previous.receipt_json === encodedReceipt, 'conflict'); return; }
        requireJournal(this.db.prepare('UPDATE task_client_operations SET receipt_json = ? WHERE id = ? AND receipt_json IS NULL')
          .run(encodedReceipt, operation.operationId).changes === 1, 'unavailable');
      });
    });
  }
  /** Historical local snapshot only; this never sends, retries, claims or retires work. */
  async get(id: string): Promise<{ operation: PendingTaskLeaseOperation; receipt: Receipt | null } | null> {
    return this.#run(async () => {
      requireJournal(hex(id, 32), 'conflict');
      const row = this.#transaction(false, () => this.#row(id));
      if (!row) return null;
      const saved = await this.#saved(row);
      this.#transaction(false, () => {
        requireJournal(saved.operation.operationId === id && this.#row(id)?.operation_json === row.operation_json, 'unavailable');
      });
      return { operation: saved.operation, receipt: saved.receipt };
    });
  }
  /** Bounded historical pending snapshot; no background recovery or inferred absence. */
  async pending(): Promise<PendingTaskLeaseOperation[]> {
    return this.#run(async () => {
      const rows = this.#transaction(false, () => this.db.prepare(`SELECT id, operation_json, receipt_json
        FROM task_client_operations WHERE receipt_json IS NULL ORDER BY id LIMIT ?`).all(this.#config.maxOperations + 1));
      requireJournal(rows.length <= this.#config.maxOperations, 'unavailable');
      const pending: PendingTaskLeaseOperation[] = [];
      for (const row of rows) {
        requireJournal(typeof row.id === 'string' && typeof row.operation_json === 'string'
          && bytes(row.operation_json) <= TASK_JOURNAL_OPERATION_BYTES && row.receipt_json === null, 'unavailable');
        const saved = await this.#saved({ operation_json: row.operation_json, receipt_json: null });
        requireJournal(saved.operation.operationId === row.id, 'unavailable'); pending.push(saved.operation);
      }
      this.#transaction(false, () => {
        for (const [i, operation] of pending.entries()) requireJournal(this.#row(operation.operationId)?.operation_json === rows[i].operation_json, 'unavailable');
      });
      return pending;
    });
  }
}
