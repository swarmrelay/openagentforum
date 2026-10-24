/** Native, opt-in laboratory. No schema initialization, route, listener or retry. */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { canonicalizeJson, verifyEnvelope, tallyPoll, checkVoteIngest, checkPollIngest,
  type MessageEnvelope, type StoredEnvelope, type PollTally } from '@openagentforum/protocol';
import { encryptionError, type EnvelopeRow } from '@openagentforum/server/envelopes';
import { POLL_WORK_LIMITS } from '@openagentforum/server/polls';
import { assertSqliteWalRuntime } from '../../server/dist/sqlite-runtime.js';
import { PollAdmissionError, configuration, need, bytes, safe, equal, tree, parseWire, recordRow, recordCost,
  decodeRow, exact, refusal, fitsPollActionInput, within, plus, minus, columnCost, wireColumns,
  messageIdentifier, channelIdentifier, agentIdentifier, hex, readAdmissionInput, type AdmissionInput,
  FIXED_ROW_BYTES, RECEIPT_BYTES, CAPTURE_BYTES, CLOSE_RESERVATION, CLOSE_HISTORY, MAX_IN_FLIGHT,
  type Capacity, type PollAdmissionOptions, type WriteRoute, type Lane, type Receipt, type ReceiptResult } from './contract.js';
import { DB_NOW, SCHEMA_OBJECTS, arrivalColumns, wakeColumns, pollReference } from './schema.js';
export { PollAdmissionError } from './contract.js';
export type { PollAdmissionOptions, PollAdmissionPolicy, Receipt, ReceiptResult, WriteRoute } from './contract.js';

type Row = Record<string, any>;
type Ledger = { used_rows: number; used_bytes: number; reserved_rows: number; reserved_bytes: number };
type Authority = Ledger & { revision: number; clock: number; window: number; attempts_json: string };
type Agent = { agent_id: string; public_key: string; registered_at: number; message_count: number; last_seen: number; wake_active: number };
type Channel = Ledger & { name: string; revision: number; high_seq: number; message_count: number;
  enabled: number; is_private: number; e2ee_required: number; allowed_agents_json: string };
type Control = { root_id: string; root_hash: string; channel: string; creator: string; creator_key: string;
  revision: number; close_recorded: number; reserved_rows: number; reserved_bytes: number;
  reserve_records: number; reserve_bytes: number; reserve_nodes: number;
  history_records: number; history_bytes: number; history_nodes: number };
type Saved = { row: EnvelopeRow; env: StoredEnvelope; receiptJson: string; actorKey: string };
type History = { root: StoredEnvelope; records: StoredEnvelope[]; control: Control; agents: Map<string, Agent> };
type Snapshot = { meta: Authority; actor: Agent; channel: Channel | null; saved: Saved | null; history: History | null };
type Decision = { env: MessageEnvelope<any>; snapshot: Snapshot; preparedAt: number; expiresAt: number;
  started: number; target: string | null; close: boolean; before: PollTally | null };
/** Values exist only in this adapter's bounded private map and cannot be serialized. */
export interface PreparedPollWrite { readonly __preparedPollWrite?: never }
const ledgerFields = ['used_rows', 'used_bytes', 'reserved_rows', 'reserved_bytes'] as const;
const used = (l: Ledger): Capacity => ({ rows: l.used_rows, bytes: l.used_bytes });
const reserved = (l: Pick<Ledger, 'reserved_rows' | 'reserved_bytes'>): Capacity => ({ rows: l.reserved_rows, bytes: l.reserved_bytes });
const zero = (): Capacity => ({ rows: 0, bytes: 0 });
const blankAttempts = () => Object.fromEntries(['ordinary', 'completion', 'recovery'].map(lane => [lane, { requests: 0, input: 0, verification: 0 }]));
const channelLedger = (c: Channel) => Object.fromEntries(['name', 'revision', 'high_seq', 'message_count', ...ledgerFields].map(k => [k, c[k as keyof Channel]]));
const publicChannel = (c: Channel | null) => c !== null && c.is_private === 0 && c.e2ee_required === 0
  && c.allowed_agents_json === '[]' && !c.name.startsWith('dm-') && !c.name.startsWith('vault-');
const publicMessage = (env: MessageEnvelope<any>, channel: Channel | null) => publicChannel(channel)
  && env.encrypted !== true && env.nonce == null && env.ephemeralPublicKey == null && env.recipientKeys == null;

/** Own a dedicated primary connection. Independent processes open the same file. */
export class SQLitePollAdmission {
  readonly #db: DatabaseSync;
  readonly #config: ReturnType<typeof configuration>;
  readonly #prepared = new Map<PreparedPollWrite, Decision>();
  #inFlight = 0;
  #poisoned = false;
  #greatestClock = 0;

  constructor(db: DatabaseSync, options: PollAdmissionOptions) {
    this.#config = configuration(options);
    // Existing maintained-runtime guard, including the WAL fixes. No bypass flag.
    assertSqliteWalRuntime(db);
    this.#db = db;
    this.#transaction(false, () => this.#authority());
  }

  #active() { need(!this.#poisoned, 'unavailable'); }
  #break(): never {
    this.#poisoned = true;
    this.#prepared.clear();
    throw new PollAdmissionError('unavailable');
  }
  #get(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.#db.prepare(sql).get(...args); }
  #all(sql: string, ...args: SQLInputValue[]): Row[] { return this.#db.prepare(sql).all(...args); }
  #run(sql: string, ...args: SQLInputValue[]) {
    const result = this.#db.prepare(sql).run(...args);
    need(result.changes === 1, 'authority');
  }
  #transaction<T>(write: boolean, action: () => T): T {
    this.#active();
    let begun = false, committing = false;
    try {
      this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
      this.#schema();
      const result = action();
      committing = true;
      this.#db.exec('COMMIT'); begun = false;
      return result;
    } catch (error) {
      let rolledBack = !begun;
      if (begun) {
        try { this.#db.exec('ROLLBACK'); rolledBack = true; } catch { /* Outcome is unknown; never retry. */ }
      }
      if (!begun && !committing && (error as { errcode?: number })?.errcode === 5) throw new PollAdmissionError('busy');
      if (error instanceof PollAdmissionError && rolledBack && !committing) {
        if (error.code === 'authority' || error.code === 'clock') { this.#poisoned = true; this.#prepared.clear(); }
        throw error;
      }
      return this.#break();
    }
  }
  #schema() {
    // Fixed-size schema inventory. No unknown trigger, index, temp shadow, attach,
    // disabled FK/CHECK, or unsafe journal setting can silently alter this contract.
    need(this.#get('PRAGMA journal_mode')?.journal_mode === 'wal'
      && this.#get('PRAGMA synchronous')?.synchronous === 2
      && this.#get('PRAGMA foreign_keys')?.foreign_keys === 1
      && this.#get('PRAGMA recursive_triggers')?.recursive_triggers === 1
      && this.#get('PRAGMA ignore_check_constraints')?.ignore_check_constraints === 0, 'authority');
    const timeout = this.#get('PRAGMA busy_timeout')?.timeout;
    need(safe(timeout) && timeout <= 1000, 'authority');
    need(!this.#get('SELECT 1 FROM sqlite_temp_schema LIMIT 1'), 'authority');
    const databases = this.#all('PRAGMA database_list');
    need(databases.length <= 2 && databases.every(d => d.name === 'main' || d.name === 'temp'), 'authority');
    const objects = this.#all(`SELECT type, CASE WHEN length(CAST(name AS BLOB)) <= 128 THEN name END AS name,
      CASE WHEN length(CAST(sql AS BLOB)) <= 32768 THEN sql END AS sql
      FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY name LIMIT ?`, SCHEMA_OBJECTS.length + 1);
    need(objects.length === SCHEMA_OBJECTS.length, 'authority');
    const expected = new Map(SCHEMA_OBJECTS.map(o => [o.name, o]));
    for (const object of objects) {
      const want = expected.get(object.name);
      need(want && want.type === object.type && want.sql === object.sql, 'authority');
    }
  }
  #authority(): Authority {
    const c = this.#config, row = this.#get('SELECT * FROM poll_admission_authority WHERE id = 1');
    need(row && row.schema_version === 1 && row.origin === c.origin && row.generation === c.generation
      && row.policy_revision === c.policyRevision && row.policy_json === c.policyJson
      && ['revision', 'clock', 'window', ...ledgerFields].every(k => safe(row[k])), 'authority');
    need(within(plus(used(row as Authority), reserved(row as Authority)), c.policy.service), 'authority');
    const attempts = JSON.parse(row.attempts_json);
    need(equal(Object.keys(attempts).sort(), ['completion', 'ordinary', 'recovery']), 'authority');
    for (const lane of ['ordinary', 'completion', 'recovery'] as const) {
      const v = attempts[lane];
      need(v && equal(Object.keys(v).sort(), ['input', 'requests', 'verification']) && safe(v.requests)
        && v.requests <= c.policy.attempts[lane] && v.input === v.requests * c.policy.wireBytes
        && v.verification === v.requests * (lane === 'recovery' ? 1 : 1 + c.policy.history.records), 'authority');
    }
    need(row.attempts_json === canonicalizeJson(attempts) && row.window === Math.floor(row.clock / c.policy.windowMs)
      && !this.#get('SELECT 1 FROM poll_admission_guard WHERE id = 1'), 'authority');
    return row as Authority;
  }
  #time(meta: Authority): number {
    const now = this.#get(`SELECT ${DB_NOW} AS now`)?.now;
    need(safe(now) && now >= meta.clock && now >= this.#greatestClock, 'clock');
    this.#greatestClock = now;
    return now;
  }
  #clock(meta: Authority, now: number) {
    const window = Math.floor(now / this.#config.policy.windowMs);
    this.#run('UPDATE poll_admission_authority SET clock = ?, window = ?, attempts_json = ? WHERE id = 1',
      now, window, window === meta.window ? meta.attempts_json : canonicalizeJson(blankAttempts()));
  }
  #charge(lane: Lane): number {
    return this.#transaction(true, () => {
      const meta = this.#authority(), now = this.#time(meta), p = this.#config.policy;
      const window = Math.floor(now / p.windowMs);
      const attempts = window === meta.window ? JSON.parse(meta.attempts_json) : blankAttempts();
      need(attempts[lane].requests < p.attempts[lane], 'attempt_capacity');
      const count = ++attempts[lane].requests;
      attempts[lane].input = count * p.wireBytes;
      attempts[lane].verification = count * (lane === 'recovery' ? 1 : 1 + p.history.records);
      this.#run('UPDATE poll_admission_authority SET clock = ?, window = ?, attempts_json = ? WHERE id = 1',
        now, window, canonicalizeJson(attempts));
      return now;
    });
  }
  #agent(id: string): Agent | null {
    const row = this.#get('SELECT * FROM agents WHERE agent_id = ?', id);
    if (!row) return null;
    need(agentIdentifier(row.agent_id) && hex(row.public_key, 64) && row.public_key === row.public_key.toLowerCase()
      && ['registered_at', 'message_count', 'last_seen'].every(k => safe(row[k])) && [0, 1].includes(row.wake_active), 'authority');
    return row as Agent;
  }
  #channel(name: string): Channel | null {
    const row = this.#get('SELECT * FROM channels WHERE name = ?', name);
    if (!row) return null;
    need(channelIdentifier(row.name) && ['revision', 'high_seq', 'message_count', ...ledgerFields].every(k => safe(row[k]))
      && row.high_seq === row.message_count
      && within(plus(used(row as Channel), reserved(row as Channel)), this.#config.policy.channel), 'authority');
    return row as Channel;
  }
  #saved(id: string): Saved | null {
    const row = this.#get(`SELECT m.*, r.receipt_json, r.actor_key, r.channel AS receipt_channel
      FROM messages m LEFT JOIN poll_admission_receipts r ON r.message_id = m.id WHERE m.id = ?`, id);
    if (!row) return null;
    need(typeof row.receipt_json === 'string' && row.receipt_channel === row.channel
      && row.charge_bytes === recordCost(row as EnvelopeRow), 'authority');
    return { row: row as EnvelopeRow, env: decodeRow(row as EnvelopeRow), receiptJson: row.receipt_json, actorKey: row.actor_key };
  }
  #control(id: string, revision: number): Control {
    const row = this.#get('SELECT * FROM poll_admission_controls WHERE root_id = ?', id);
    need(row, 'unsupported_history');
    need(row.revision > 0 && row.revision <= revision && ['revision', 'reserved_rows', 'reserved_bytes', 'reserve_records',
      'reserve_bytes', 'reserve_nodes', 'history_records', 'history_bytes', 'history_nodes'].every(k => safe(row[k]))
      && within(reserved(row as Control), CLOSE_RESERVATION)
      && within({ records: row.reserve_records, bytes: row.reserve_bytes, nodes: row.reserve_nodes }, CLOSE_HISTORY)
      && row.reserve_records === (row.close_recorded === 1 ? 0 : 1), 'authority');
    return row as Control;
  }
  #history(pollId: string, channel: string, revision: number): History {
    const root = this.#saved(pollId), control = this.#control(pollId, revision);
    need(root && root.env.channel === channel && root.env.type === 'poll' && (root.env.payload as any)?.kind === 'open'
      && root.env.checksum === control.root_hash && root.env.sender === control.creator && control.channel === channel, 'unsupported_history');
    const creator = this.#agent(root.env.sender);
    need(creator && creator.public_key === control.creator_key, 'authority');
    const rootBytes = recordCost(root.row), p = this.#config.policy;
    // The indexed scan reads at most policy.records + 1 candidates. Only rowids
    // and costs enter picked; an overflowing history returns a metadata sentinel.
    const rows = this.#all(`WITH picked AS MATERIALIZED (
      SELECT rowid AS rid, charge_bytes AS bytes FROM messages INDEXED BY idx_messages_poll_reference
      WHERE channel = ? AND ${pollReference} = ? AND type IN ('vote','poll') AND id != ?
      ORDER BY stored_seq, id LIMIT ?
    ), bounds AS MATERIALIZED (
      SELECT count(*) AS total, COALESCE(sum(bytes), 0) AS total_bytes, COALESCE(max(bytes), 0) AS largest FROM picked
    ) SELECT b.total, b.total_bytes, b.largest, m.*, a.public_key, a.registered_at
      FROM bounds b LEFT JOIN picked p ON b.total + 1 <= ? AND b.total_bytes + ? <= ? AND b.largest <= ?
      LEFT JOIN messages m ON m.rowid = p.rid LEFT JOIN agents a ON a.agent_id = m.sender
      ORDER BY m.stored_seq, m.id`, channel, pollId, pollId, p.history.records + 1,
    p.history.records - control.reserve_records, rootBytes + control.reserve_bytes, p.history.bytes, POLL_WORK_LIMITS.recordBytes);
    const first = rows[0];
    need(first && [first.total, first.total_bytes, first.largest].every(safe), 'authority');
    need(first.total + 1 + control.reserve_records <= p.history.records
      && first.total_bytes + rootBytes + control.reserve_bytes <= p.history.bytes
      && first.largest <= POLL_WORK_LIMITS.recordBytes, 'history_capacity');
    need(rows.length === Math.max(1, first.total), 'authority');
    const records = [root.env], agents = new Map<string, Agent>([[creator.agent_id, creator]]);
    let nodes = tree(root.env.payload) + (root.env.recipientKeys == null ? 0 : tree(root.env.recipientKeys));
    for (const row of rows) {
      if (first.total === 0) { need(row.id === null, 'authority'); break; }
      need(messageIdentifier(row.id) && hex(row.public_key, 64) && row.public_key === row.public_key.toLowerCase() && safe(row.registered_at)
        && row.charge_bytes === recordCost(row as EnvelopeRow), 'authority');
      const env = decodeRow(row as EnvelopeRow);
      nodes += tree(env.payload) + (env.recipientKeys == null ? 0 : tree(env.recipientKeys));
      need(nodes + control.reserve_nodes <= p.history.nodes, 'history_capacity');
      records.push(env);
      agents.set(env.sender, { agent_id: env.sender, public_key: row.public_key, registered_at: row.registered_at,
        message_count: 0, last_seen: 0, wake_active: 0 });
    }
    need(nodes + control.reserve_nodes <= p.history.nodes, 'history_capacity');
    need(control.history_records === records.length && control.history_bytes === rootBytes + first.total_bytes
      && control.history_nodes === nodes, 'authority');
    return { root: root.env, records, control, agents };
  }
  #fresh(decision: Pick<Decision, 'started' | 'preparedAt' | 'expiresAt'>, now: number) {
    need(now >= decision.preparedAt, 'clock');
    need(now <= decision.expiresAt && performance.now() - decision.started <= this.#config.policy.preparationMs, 'preparation_expired');
  }
  #enter() {
    this.#active();
    for (const [token, d] of this.#prepared) {
      if (performance.now() - d.started > this.#config.policy.preparationMs) this.#prepared.delete(token);
    }
    need(this.#inFlight + this.#prepared.size < MAX_IN_FLIGHT, 'busy');
    this.#inFlight++;
  }

  async prepare(input: AdmissionInput, route: WriteRoute = {}): Promise<PreparedPollWrite> {
    route = { ...route };
    this.#enter();
    try {
      const lane = route.lane ?? 'ordinary';
      need(lane === 'ordinary' || lane === 'completion', 'route');
      const started = performance.now(), preparedAt = this.#charge(lane), p = this.#config.policy;
      const expiresAt = preparedAt + p.preparationMs;
      need(safe(expiresAt), 'clock');
      this.#fresh({ started, preparedAt, expiresAt }, preparedAt);
      const wire = await readAdmissionInput(input);
      this.#active(); this.#fresh({ started, preparedAt, expiresAt }, preparedAt);
      const env = parseWire(wire, p), close = env.type === 'poll' && env.payload?.kind === 'close';
      need(route.channel === undefined || route.channel === env.channel, 'route');
      need(close ? lane === 'completion' && route.pollId === env.payload.pollId : lane === 'ordinary' && route.pollId === undefined, 'route');
      const target = env.type === 'vote' || close ? env.payload?.pollId : null;
      need(target === null || messageIdentifier(target), 'invalid_payload');
      const snapshot = this.#transaction(false, (): Snapshot => {
        const meta = this.#authority(), now = this.#time(meta);
        this.#fresh({ started, preparedAt, expiresAt }, now);
        const actor = this.#agent(env.sender);
        need(actor, 'signature');
        const saved = this.#saved(env.id), channel = this.#channel(env.channel);
        if (saved) return { meta, actor, channel, saved, history: null };
        need(channel?.enabled === 1 && publicChannel(channel), 'channel');
        need(!encryptionError(env, channel.e2ee_required === 1 || channel.is_private === 1), 'encryption');
        need(fitsPollActionInput(env), 'input_limit');
        const history = target === null ? null : this.#history(target, env.channel, meta.revision);
        return { meta, actor, channel, saved: null, history };
      });
      need((await verifyEnvelope(env, snapshot.actor.public_key)).valid, 'signature');
      this.#active();
      let before: PollTally | null = null;
      if (snapshot.saved) need(exact(snapshot.saved.env, env), 'operation_conflict');
      else if (env.type === 'poll' && env.payload?.kind === 'open') {
        need(env.payload.closePolicy?.creator === true && !Object.hasOwn(env.payload, 'pollId'), 'unsupported_profile');
        refusal(checkPollIngest(env, null, null, { hub: this.#config.origin }).refusal);
      } else if (env.type === 'poll' || env.type === 'vote') {
        need(snapshot.history, 'invalid_payload');
        const h = snapshot.history;
        before = await tallyPoll(h.root, h.records, async id => h.agents.get(id)?.public_key,
          { registeredAt: async id => h.agents.get(id)?.registered_at, now: preparedAt });
        this.#active();
        refusal(env.type === 'vote' ? checkVoteIngest(env, h.root, before,
          { hub: this.#config.origin, now: preparedAt, voterRegisteredAt: snapshot.actor.registered_at })
          : checkPollIngest(env, h.root, before, { hub: this.#config.origin }).refusal);
      }
      const decision: Decision = { env, snapshot, preparedAt, expiresAt, started, target, close, before };
      this.#transaction(false, () => this.#fresh(decision, this.#time(this.#authority())));
      this.#fresh(decision, this.#greatestClock);
      const token = Object.freeze({});
      this.#prepared.set(token, decision);
      return token;
    } catch (error) {
      if (error instanceof PollAdmissionError) throw error;
      return this.#break();
    } finally { this.#inFlight--; }
  }

  #receipt(saved: Saved, env: MessageEnvelope<any>, actorKey: string, now: number): ReceiptResult {
    need(exact(saved.env, env) && saved.actorKey === actorKey, 'operation_conflict');
    const r: Receipt = JSON.parse(saved.receiptJson), c = this.#config;
    need(r && r.origin === c.origin && r.generation === c.generation && r.policyRevision === c.policyRevision
      && r.id === env.id && r.channel === env.channel && r.actorKey === actorKey && r.signature === env.signature
      && r.checksum === env.checksum && r.storedSeq === saved.env.storedSeq && safe(r.committedAt)
      && r.committedAt <= now && r.historical === true && (r.pollRevision === null || safe(r.pollRevision) && r.pollRevision > 0), 'authority');
    if (!publicMessage(saved.env, this.#channel(env.channel))) return { outcome: 'unavailable', historical: true };
    return { outcome: 'found', receipt: r, historical: true };
  }

  async recover(input: AdmissionInput, channel?: string): Promise<ReceiptResult> {
    this.#enter();
    try {
      const started = performance.now(), preparedAt = this.#charge('recovery');
      const expiresAt = preparedAt + this.#config.policy.preparationMs;
      need(safe(expiresAt), 'clock');
      this.#fresh({ started, preparedAt, expiresAt }, preparedAt);
      const wire = await readAdmissionInput(input);
      this.#active(); this.#fresh({ started, preparedAt, expiresAt }, preparedAt);
      const env = parseWire(wire, this.#config.policy);
      need(channel === undefined || channel === env.channel, 'route');
      const actor = this.#transaction(false, () => { this.#time(this.#authority()); return this.#agent(env.sender); });
      need(actor && (await verifyEnvelope(env, actor.public_key)).valid, 'signature');
      this.#active();
      const result = this.#transaction(false, () => {
        const meta = this.#authority(), now = this.#time(meta);
        this.#fresh({ started, preparedAt, expiresAt }, now);
        need(this.#agent(env.sender)?.public_key === actor.public_key, 'authority');
        const saved = this.#saved(env.id);
        const result: ReceiptResult = saved ? this.#receipt(saved, env, actor.public_key, now) : { outcome: 'unavailable', historical: true };
        this.#fresh({ started, preparedAt, expiresAt }, this.#time(meta));
        return result;
      });
      this.#fresh({ started, preparedAt, expiresAt }, this.#greatestClock);
      return result;
    } catch (error) {
      if (error instanceof PollAdmissionError) throw error;
      return this.#break();
    } finally { this.#inFlight--; }
  }

  commit(token: PreparedPollWrite): ReceiptResult {
    this.#active();
    const decision = this.#prepared.get(token);
    need(decision, 'unprepared');
    this.#prepared.delete(token);
    const result = this.#transaction(true, () => this.#commit(decision));
    // A late COMMIT acknowledgement may describe committed data. Withhold success
    // and poison every pending operation; only exact historical recovery settles it.
    if (performance.now() - decision.started > this.#config.policy.preparationMs) return this.#break();
    return result;
  }

  #commit(d: Decision): ReceiptResult {
    const c = this.#config, p = c.policy, meta = this.#authority(), now = this.#time(meta);
    this.#fresh(d, now);
    const { env, snapshot, target, close, before } = d;
    const actor = this.#agent(env.sender);
    need(actor && actor.public_key === snapshot.actor.public_key, 'authority');
    const saved = this.#saved(env.id);
    if (saved) { this.#clock(meta, now); return this.#receipt(saved, env, actor.public_key, now); }
    need(!snapshot.saved, 'authority');
    const channel = this.#channel(env.channel);
    need(channel && channel.enabled === 1 && meta.revision === snapshot.meta.revision
      && equal(channel, snapshot.channel) && equal(actor, snapshot.actor), 'stale');
    let oldControl: Control | null = null;
    if (target !== null) {
      oldControl = this.#control(target, meta.revision);
      need(snapshot.history && equal(oldControl, snapshot.history.control), 'stale');
      refusal(env.type === 'vote' ? checkVoteIngest(env, snapshot.history.root, before,
        { hub: c.origin, now, voterRegisteredAt: actor.registered_at })
        : checkPollIngest(env, snapshot.history.root, before, { hub: c.origin }).refusal);
    }
    need([channel.high_seq + 1, channel.revision + 1, actor.message_count + 1, meta.revision + 1].every(safe), 'storage_capacity');
    const row = recordRow(env, channel.high_seq + 1), messageBytes = recordCost(row);
    need(messageBytes <= POLL_WORK_LIMITS.recordBytes, 'history_capacity');
    const historyNodes = tree(env.payload) + (env.recipientKeys == null ? 0 : tree(env.recipientKeys));
    const root = env.type === 'poll' && env.payload.kind === 'open';
    const pollRevision = root ? 1 : oldControl ? oldControl.revision + 1 : null;
    const receipt: Receipt = { origin: c.origin, generation: c.generation, policyRevision: c.policyRevision,
      id: env.id, channel: env.channel, actorKey: actor.public_key, signature: env.signature, checksum: env.checksum,
      storedSeq: row.stored_seq!, pollRevision, committedAt: now, historical: true };
    const receiptJson = JSON.stringify(receipt), receiptBytes = 512 + bytes(receiptJson);
    need(receiptBytes <= RECEIPT_BYTES, 'storage_capacity');
    const capture = this.#capturePlan(env, channel, row.stored_seq!, now);
    const actionCost = { rows: 2 + capture.rows.length, bytes: messageBytes + receiptBytes + capture.bytes };
    let control: Control | null = null, reserveDelta = zero();
    if (root) {
      control = { root_id: env.id, root_hash: env.checksum, channel: env.channel, creator: env.sender, creator_key: actor.public_key,
        revision: 1, close_recorded: 0, reserved_rows: CLOSE_RESERVATION.rows, reserved_bytes: CLOSE_RESERVATION.bytes,
        reserve_records: CLOSE_HISTORY.records, reserve_bytes: CLOSE_HISTORY.bytes, reserve_nodes: CLOSE_HISTORY.nodes,
        history_records: 1, history_bytes: messageBytes, history_nodes: historyNodes };
      reserveDelta = { ...CLOSE_RESERVATION };
    } else if (oldControl) {
      control = { ...oldControl, revision: pollRevision!, history_records: oldControl.history_records + 1,
        history_bytes: oldControl.history_bytes + messageBytes, history_nodes: oldControl.history_nodes + historyNodes };
      if (close) {
        need(oldControl.close_recorded === 0 && within(actionCost, reserved(oldControl)), 'storage_capacity');
        control.close_recorded = 1;
        control.reserved_rows -= actionCost.rows; control.reserved_bytes -= actionCost.bytes;
        control.reserve_records--; control.reserve_bytes -= messageBytes; control.reserve_nodes -= historyNodes;
        reserveDelta = minus(zero(), actionCost);
      }
    }
    if (control) need(within({ records: control.history_records + control.reserve_records,
      bytes: control.history_bytes + control.reserve_bytes, nodes: control.history_nodes + control.reserve_nodes }, p.history), 'history_capacity');
    const added = plus(actionCost, root ? { rows: 1, bytes: FIXED_ROW_BYTES } : zero());
    // Check the INSERT-before-eviction peak using the retained ledger, including
    // the reservation conversion. Never spend the future retirement in advance.
    need(within(plus(plus(used(meta), added), plus(reserved(meta), reserveDelta)), p.service)
      && within(plus(plus(used(channel), added), plus(reserved(channel), reserveDelta)), p.channel), 'storage_capacity');
    const retired = capture.retired.reduce((sum, r) => plus(sum, { rows: 1, bytes: r.charge_bytes }), zero());
    const nextMeta = { revision: meta.revision + 1, clock: now,
      used_rows: meta.used_rows + added.rows - retired.rows, used_bytes: meta.used_bytes + added.bytes - retired.bytes,
      reserved_rows: meta.reserved_rows + reserveDelta.rows, reserved_bytes: meta.reserved_bytes + reserveDelta.bytes };
    const nextChannel: Channel = { ...channel, revision: channel.revision + 1, high_seq: channel.high_seq + 1,
      message_count: channel.message_count + 1, used_rows: channel.used_rows + added.rows,
      used_bytes: channel.used_bytes + added.bytes, reserved_rows: channel.reserved_rows + reserveDelta.rows,
      reserved_bytes: channel.reserved_bytes + reserveDelta.bytes };
    const affected = new Map<string, Channel>([[channel.name, nextChannel]]);
    for (const old of capture.retired) {
      let ch = affected.get(old.channel);
      if (!ch) { ch = this.#channel(old.channel)!; need(ch, 'authority'); affected.set(old.channel, ch); }
      ch.used_rows--; ch.used_bytes -= old.charge_bytes;
    }
    const expected = { authority: nextMeta, channels: [...affected.values()].map(channelLedger), control,
      actor: { agent_id: actor.agent_id, public_key: actor.public_key, message_count: actor.message_count + 1, last_seen: now },
      message: { id: env.id, channel: env.channel, sender: env.sender, stored_seq: row.stored_seq,
        signature: env.signature, checksum: env.checksum, charge_bytes: messageBytes },
      receipt_json: receiptJson, arrival_seq: capture.arrivalSeq, wake_seq: capture.wakeSeq };
    const voteDeadline = env.type === 'vote' ? (snapshot.history!.root.payload as any).closes?.at ?? null : null;
    this.#run(`INSERT INTO poll_admission_guard (id, message_id, origin, generation, policy_revision, policy_json,
      prepared_at, expires_at, vote_deadline, expected_json) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    env.id, c.origin, c.generation, c.policyRevision, c.policyJson, d.preparedAt, d.expiresAt, voteDeadline, JSON.stringify(expected));
    this.#clock(meta, now);
    // Reserve before message triggers allocate captures. The root FK is deferred
    // only until this transaction commits, never across operations or processes.
    if (control) {
      if (root) {
        const fields = Object.keys(control);
        this.#run(`INSERT INTO poll_admission_controls (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
          ...Object.values(control));
      } else {
        const fields = ['revision', 'close_recorded', 'reserved_rows', 'reserved_bytes', 'reserve_records', 'reserve_bytes',
          'reserve_nodes', 'history_records', 'history_bytes', 'history_nodes'] as const;
        this.#run(`UPDATE poll_admission_controls SET ${fields.map(k => k + ' = ?').join(',')} WHERE root_id = ? AND revision = ?`,
          ...fields.map(k => control![k]), target!, oldControl!.revision);
      }
    }
    this.#run(`INSERT INTO messages (${wireColumns.join(',')}) VALUES (${wireColumns.map(() => '?').join(',')})`,
      ...wireColumns.map(k => row[k]));
    this.#run('INSERT INTO poll_admission_receipts (message_id, channel, actor_key, receipt_json) VALUES (?, ?, ?, ?)',
      env.id, env.channel, actor.public_key, receiptJson);
    this.#run('UPDATE channels SET high_seq = high_seq + 1, message_count = message_count + 1, revision = revision + 1 WHERE name = ?', env.channel);
    this.#run('UPDATE agents SET message_count = message_count + 1, last_seen = ? WHERE agent_id = ?', now, env.sender);
    this.#run('UPDATE poll_admission_authority SET revision = revision + 1 WHERE id = 1 AND revision = ?', meta.revision);
    // A synchronous transaction can still cross a deadline during disk/trigger
    // work. Recheck in SQL as the final statement, after every mutation/capture.
    const finalNow = this.#time({ ...meta, clock: now });
    this.#fresh(d, finalNow);
    nextMeta.clock = finalNow;
    this.#clock({ ...meta, clock: now }, finalNow);
    this.#run('UPDATE poll_admission_guard SET expected_json = ? WHERE id = 1', JSON.stringify(expected));
    this.#run('DELETE FROM poll_admission_guard WHERE id = 1');
    return { outcome: 'found', receipt, historical: true, replayed: false };
  }

  #capturePlan(env: MessageEnvelope<any>, channel: Channel, storedSeq: number, now: number) {
    let arrivalSeq = this.#get('SELECT high_seq FROM public_recent_state WHERE id = 1')?.high_seq;
    let wakeSeq = this.#get('SELECT high_seq FROM wake_recent_state WHERE id = 1')?.high_seq;
    need(safe(arrivalSeq) && safe(wakeSeq), 'authority');
    const owner = this.#get('SELECT MAX(agent_id) AS id FROM agents INDEXED BY idx_poll_agents_wake WHERE wake_active = 1')?.id;
    const rows: Record<string, SQLInputValue>[] = [], retired: { channel: string; charge_bytes: number }[] = [];
    let totalBytes = 0;
    if (publicMessage(env, channel)) {
      need(safe(arrivalSeq + 1), 'storage_capacity');
      const row = { arrival_seq: ++arrivalSeq, envelope_id: env.id, channel: env.channel, stored_seq: storedSeq, arrived_at: now };
      rows.push(row); totalBytes += columnCost(arrivalColumns.map(k => row[k as keyof typeof row]));
      const old = this.#all('SELECT channel, charge_bytes FROM public_message_arrivals WHERE arrival_seq <= ? LIMIT 2',
        arrivalSeq - this.#config.policy.captureRetention);
      need(old.length <= 1, 'authority'); retired.push(...old as typeof retired);
    }
    if (this.#config.policy.wakeActive && owner != null && bytes(JSON.stringify(env.payload)) <= 65536) {
      need(agentIdentifier(owner) && safe(wakeSeq + 1), 'authority');
      const row = { seq: ++wakeSeq, envelope_id: env.id, stored_at: now, owner_after: '', owner_until: owner };
      rows.push(row); totalBytes += columnCost(wakeColumns.map(k => row[k as keyof typeof row]));
      const old = this.#all(`SELECT m.channel, w.charge_bytes FROM wake_message_outbox w JOIN messages m ON m.id = w.envelope_id
        WHERE w.seq <= ? LIMIT 2`, wakeSeq - this.#config.policy.captureRetention);
      need(old.length <= 1, 'authority'); retired.push(...old as typeof retired);
    }
    need(rows.every(row => columnCost(Object.values(row)) <= CAPTURE_BYTES)
      && retired.every(row => safe(row.charge_bytes) && row.charge_bytes <= CAPTURE_BYTES), 'authority');
    return { rows, retired, bytes: totalBytes, arrivalSeq, wakeSeq };
  }
}
