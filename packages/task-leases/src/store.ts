/** Shared bounded operation scope. Only the adapters supply native SQL authority. */
import { canonicalizeJson } from '@openagentforum/protocol';
import { TaskLeaseError, LIMITS, configuration, need, integer, object, bytes, verifyWire, fresh, taskId, view,
  type Options, type Input, type Proof, type Lane, type Result } from './contract.js';
import { authority, actor, task, receipt, existing, plan, blankAttempts, type Raw, type Snapshot } from './state.js';
import { SCHEMA_JSON } from './schema.js';
import { META_SQL, SNAPSHOT_SQL, CHARGE_SQL, STAGE_SQL, MUTATION_SQL } from './sql.js';

export type SqlValue = string | number | null;
export interface Statement { sql: string; values: SqlValue[] }
export interface Transport {
  query(statement: Statement): Promise<Raw[]>;
  batch(statements: Statement[]): Promise<Raw[][]>;
}
/** Instance-bound and single-use; never a transferable authorization permit. */
export interface PreparedLeaseWrite { readonly __preparedLeaseWrite?: never }
interface Lifetime { started: number; preparedAt: number; expiresAt: number; signal?: AbortSignal; proofExpiresAt?: number }
interface Decision extends Lifetime { proof: Proof }
const statement = (sql: string, request: unknown = {}): Statement => ({ sql, values: [SCHEMA_JSON, canonicalizeJson(request)] });

export class TaskLeaseStore {
  readonly #transport: Transport;
  readonly #config: ReturnType<typeof configuration>;
  readonly #prepared = new Map<PreparedLeaseWrite, Decision>();
  #inFlight = 0;
  #poisoned = false;
  #greatestClock = 0;

  constructor(transport: Transport, options: Options) {
    this.#transport = transport; this.#config = configuration(options);
  }
  #active() { need(!this.#poisoned, 'unavailable'); }
  #fail(error: unknown): never {
    if (!(error instanceof TaskLeaseError) || ['authority', 'clock', 'unavailable'].includes(error.code)) {
      this.#poisoned = true; this.#prepared.clear();
    }
    throw error instanceof TaskLeaseError ? error : new TaskLeaseError('unavailable');
  }
  #enter() {
    this.#active();
    for (const [token, d] of this.#prepared) {
      if (performance.now() - d.started > this.#config.policy.preparationMs) this.#prepared.delete(token);
    }
    need(this.#inFlight + this.#prepared.size < LIMITS.inFlight, 'busy'); this.#inFlight++;
  }
  #fresh(life: Lifetime, now: number) {
    this.#active(); need(now >= life.preparedAt, 'clock');
    need(!life.signal?.aborted && now <= life.expiresAt
      && performance.now() - life.started <= this.#config.policy.preparationMs, 'preparation_expired');
    // Anchor monotonic elapsed time before the first primary read. This is
    // conservative across awaits and does not trust the application wall clock.
    if (life.proofExpiresAt !== undefined) need(now < life.proofExpiresAt
      && performance.now() - life.started < life.proofExpiresAt - life.preparedAt, 'proof_expired');
  }
  #metadata(row: Raw) {
    need(row.schema_ok === 1 && row.guard_empty === 1, 'authority');
    const meta = authority(row, this.#config), now = row.db_now;
    need(integer(now) && now >= meta.clock && now >= this.#greatestClock, 'clock');
    need(meta.window === Math.floor(meta.clock / this.#config.policy.windowMs), 'authority');
    this.#greatestClock = now; return { meta, now };
  }
  async #meta() {
    const rows = await this.#transport.query(statement(META_SQL)); this.#active();
    need(rows.length === 1, 'authority'); return this.#metadata(rows[0]);
  }
  async #charge(lane: Lane, started: number): Promise<Lifetime> {
    const { meta, now } = await this.#meta(), p = this.#config.policy;
    const life = { started, preparedAt: now, expiresAt: now + p.preparationMs };
    need(integer(life.expiresAt), 'clock'); this.#fresh(life, now);
    const window = Math.floor(now / p.windowMs);
    const attempts: Record<Lane, number> = window === meta.window ? JSON.parse(meta.attempts_json) : blankAttempts();
    need(attempts[lane] < p.attempts[lane], 'attempt_capacity'); attempts[lane]++;
    const rows = await this.#transport.query(statement(CHARGE_SQL, { meta, window, attempts: canonicalizeJson(attempts),
      observedAt: now, expiresAt: life.expiresAt }));
    this.#active(); need(rows.length <= 1, 'authority'); need(rows.length === 1, 'busy');
    need(integer(rows[0].clock) && rows[0].clock >= now, 'clock');
    this.#fresh(life, rows[0].clock); this.#greatestClock = rows[0].clock; return life;
  }
  async #proof(input: Input, life: Lifetime) {
    this.#fresh(life, this.#greatestClock);
    need(typeof input === 'string' || object(input) && typeof input.read === 'function', 'invalid');
    if (typeof input !== 'string') need(!input.signal?.aborted, 'preparation_expired');
    const wire = typeof input === 'string' ? input : await input.read();
    this.#fresh(life, this.#greatestClock);
    if (typeof input !== 'string') need(!input.signal?.aborted, 'preparation_expired');
    const proof = await verifyWire(wire); life.proofExpiresAt = proof.command.expiresAt;
    this.#fresh(life, this.#greatestClock); return proof;
  }
  async #snapshot(id: string, key: string | null, life: Lifetime): Promise<Snapshot> {
    const rows = await this.#transport.query(statement(SNAPSHOT_SQL, { taskId: id, actor: key }));
    this.#fresh(life, this.#greatestClock);
    need(rows.length >= 1 && rows.length <= 3 && rows.every(r => ['meta', 'actor', 'task'].includes(String(r.kind))), 'authority');
    const one = (kind: string) => {
      const selected = rows.filter(r => r.kind === kind); need(selected.length <= 1, 'authority');
      if (!selected.length) return null;
      const body = selected[0].body;
      need(typeof body === 'string' && bytes(body) <= 2 * (LIMITS.stateBytes + LIMITS.wireBytes + LIMITS.receiptBytes) + 4096, 'authority');
      const parsed: unknown = JSON.parse(body); need(object(parsed), 'authority'); return parsed;
    };
    const m = one('meta'); need(m, 'authority'); const { meta, now } = this.#metadata(m);
    this.#fresh(life, now);
    const t = task(one('task'), this.#config.audience), a = actor(one('actor'), this.#config.policy);
    need((!t || t.row.task_id === id && now >= t.state.updatedAt) && (!a || a.public_key === key), 'authority');
    return { meta, now, actor: a, task: t?.row ?? null, state: t?.state ?? null };
  }
  async prepare(input: Input, lane: Exclude<Lane, 'recovery'> = 'ordinary'): Promise<PreparedLeaseWrite> {
    this.#enter();
    try {
      need(lane === 'ordinary' || lane === 'completion', 'route');
      const life = await this.#charge(lane, performance.now());
      life.signal = typeof input !== 'string' && object(input) ? input.signal : undefined;
      const proof = await this.#proof(input, life), c = proof.command;
      need(c.action !== 'receipt' && (c.action === 'submit' || c.action === 'release' ? lane === 'completion' : lane === 'ordinary'), 'route');
      const snapshot = await this.#snapshot(proof.taskId, c.actorKey, life);
      plan(snapshot, proof, this.#config); this.#fresh(life, snapshot.now);
      const token = Object.freeze({}); this.#prepared.set(token, { ...life, proof }); return token;
    } catch (error) { return this.#fail(error); }
    finally { this.#inFlight--; }
  }
  async commit(token: PreparedLeaseWrite): Promise<Result> {
    this.#active(); const d = this.#prepared.get(token); need(d, 'unprepared');
    this.#prepared.delete(token); this.#inFlight++;
    try {
      this.#fresh(d, this.#greatestClock);
      const proof = d.proof, c = proof.command, snapshot = await this.#snapshot(proof.taskId, c.actorKey, d);
      const next = plan(snapshot, proof, this.#config);
      if (next.replay) return { outcome: 'found', receipt: next.replay, historical: true, replayed: true };
      const request = { before: { meta: snapshot.meta, actor: snapshot.actor, task: snapshot.task },
        taskId: proof.taskId, action: c.action, wire: proof.wire, creation: next.creation ? 1 : 0,
        nextActor: next.nextActor, nextState: next.nextState, nextReceipt: next.nextReceipt,
        observedAt: snapshot.now, expiresAt: d.expiresAt, proofExpiresAt: c.expiresAt, issuedAt: c.issuedAt,
        submitDeadline: c.action === 'submit' ? snapshot.state!.lease!.expiresAt : null,
        reclaimAfter: (c.action === 'claim' || c.action === 'reopen') && snapshot.state?.status === 'claimed'
          ? snapshot.state.lease!.expiresAt : null };
      const results = await this.#transport.batch([statement(STAGE_SQL, request), ...MUTATION_SQL.map(sql => ({ sql, values: [] }))]);
      this.#active();
      // A delayed committed batch is uncertain to its caller. Poison every
      // outstanding token and require explicit receipt recovery on a fresh store.
      const elapsed = performance.now() - d.started;
      need(!d.signal?.aborted && elapsed <= this.#config.policy.preparationMs
        && elapsed < c.expiresAt - d.preparedAt, 'unavailable');
      need(results.length === MUTATION_SQL.length + 1 && results.every(Array.isArray), 'authority');
      const final = results.at(-1)!, saved = results.at(-2)!;
      need(final.length <= 1 && saved.length <= 1, 'authority');
      if (!final.length) { need(!saved.length, 'authority'); throw new TaskLeaseError('stale'); }
      need(final[0].id === 1 && integer(final[0].db_now) && saved.length === 1, 'authority');
      this.#fresh(d, final[0].db_now); fresh(proof, this.#config.audience, final[0].db_now);
      this.#greatestClock = Math.max(this.#greatestClock, final[0].db_now);
      const raw = saved[0].receipt_json; need(typeof raw === 'string' && bytes(raw) <= LIMITS.receiptBytes, 'authority');
      const r = receipt(JSON.parse(raw), next.nextState);
      need(r.actorKey === c.actorKey && r.operationId === c.operationId && r.commandDigest === proof.digest
        && r.revision === next.nextReceipt.revision && r.generation === next.nextReceipt.generation
        && r.action === c.action && r.status === next.nextReceipt.status && r.resultDigest === proof.resultDigest
        && r.resolutionDigest === next.nextReceipt.resolutionDigest && r.committedAt >= snapshot.now
        && r.committedAt <= final[0].db_now, 'authority');
      return { outcome: 'found', receipt: r, historical: true, replayed: false };
    } catch (error) { return this.#fail(error); }
    finally { this.#inFlight--; }
  }
  async recover(input: Input): Promise<Result> {
    this.#enter();
    try {
      const life = await this.#charge('recovery', performance.now());
      life.signal = typeof input !== 'string' && object(input) ? input.signal : undefined;
      const proof = await this.#proof(input, life);
      need(proof.command.action === 'receipt', 'route');
      const s = await this.#snapshot(proof.taskId, proof.command.actorKey, life);
      fresh(proof, this.#config.audience, s.now);
      const r = s.actor?.enabled === 1 ? existing(s, proof) : null;
      this.#fresh(life, s.now);
      return r ? { outcome: 'found', receipt: r, historical: true } : { outcome: 'unavailable', historical: true };
    } catch (error) { return this.#fail(error); }
    finally { this.#inFlight--; }
  }
  /** Anonymous, one primary snapshot; no work charge or business-state write. */
  async readTask(id: string) {
    this.#enter();
    try {
      need(taskId(id), 'invalid');
      const life = { started: performance.now(), preparedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
      const s = await this.#snapshot(id, null, life); this.#fresh(life, s.now);
      return s.state ? view(s.state, s.now) : null;
    } catch (error) { return this.#fail(error); }
    finally { this.#inFlight--; }
  }
}
