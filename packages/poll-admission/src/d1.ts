/** Unmounted D1 poll admission laboratory. No setup, route, retry or fallback. */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { canonicalizeJson, verifyEnvelope, tallyPoll, checkPollIngest, checkVoteIngest, type PollTally } from '@openagentforum/protocol';
import { encryptionError } from '@openagentforum/server/envelopes';
import { POLL_WORK_LIMITS } from '@openagentforum/server/polls';
import { PollAdmissionError, configuration, need, bytes, safe, equal, tree, parseWire, decodeRow, exact, refusal,
  fitsPollActionInput, messageIdentifier, agentIdentifier, channelIdentifier, hex, wireColumns, CAPTURE_BYTES, MAX_IN_FLIGHT,
  readAdmissionInput, type AdmissionInput, type PollAdmissionOptions, type WriteRoute, type Lane, type ReceiptResult } from './contract.js';
import { authority, agent, channel, control, saved, stored, receipt, proposal, payload, publicChannel,
  blankAttempts, controlFields, type Raw, type Snapshot, type Decision, type Lifetime, type Wire, type History,
  type Agent, type Capture } from './d1-state.js';
import { D1_SCHEMA_JSON, META_SQL, SNAPSHOT_SQL, CHARGE_SQL, STAGE_SQL, ADMITTED, ADVANCE_CLOCK_SQL } from './d1-sql.js';

export { PollAdmissionError } from './contract.js';
export type { PollAdmissionOptions, PollAdmissionPolicy, Receipt, ReceiptResult, WriteRoute } from './contract.js';
/** Opaque, instance-bound, single-use. Not a serializable proof or permit. */
export interface PreparedD1PollWrite { readonly __preparedD1PollWrite?: never }
type ReadInput = { actor?: string; channel?: string; id?: string; target?: string | null;
  history?: boolean; capture?: boolean; inBatch?: boolean };
type SqlValue = string | number | null;

/** Own one bounded operation scope for the caller's lifetime; never Worker globals. */
export class D1PollAdmission {
  readonly #db: Pick<D1Database, 'withSession'>;
  readonly #config: ReturnType<typeof configuration>;
  readonly #prepared = new Map<PreparedD1PollWrite, Decision>();
  #inFlight = 0;
  #poisoned = false;
  #greatestClock = 0;

  constructor(db: Pick<D1Database, 'withSession'>, options: PollAdmissionOptions) {
    this.#config = configuration(options);
    this.#db = db; // No I/O, DDL, pragma changes, policy adoption or request-time seed.
  }
  #active() { need(!this.#poisoned, 'unavailable'); }
  #break(): never {
    this.#poisoned = true; this.#prepared.clear();
    throw new PollAdmissionError('unavailable');
  }
  #fail(error: unknown): never {
    if (error instanceof PollAdmissionError) {
      if (error.code === 'authority' || error.code === 'clock' || error.code === 'unavailable') {
        this.#poisoned = true; this.#prepared.clear();
      }
      throw error;
    }
    return this.#break(); // Never parse driver error text into a promise of rollback.
  }
  #enter() {
    this.#active();
    for (const [token, d] of this.#prepared) if (performance.now() - d.started > this.#config.policy.preparationMs) this.#prepared.delete(token);
    need(this.#inFlight + this.#prepared.size < MAX_IN_FLIGHT, 'busy'); this.#inFlight++;
  }
  #fresh(life: Lifetime, now: number) {
    this.#active();
    need(now >= life.preparedAt, 'clock');
    need(now <= life.expiresAt && performance.now() - life.started <= this.#config.policy.preparationMs, 'preparation_expired');
  }
  #metadata(row: Raw, inBatch = false) {
    need(row.schema_ok === 1 && (row.guard_empty === 1 || inBatch && row.guard_empty === 0), 'authority');
    const meta = authority(row, this.#config), now = row.db_now;
    need(safe(now) && now >= meta.clock && now >= this.#greatestClock, 'clock');
    this.#greatestClock = now;
    return { meta, now };
  }
  async #meta() {
    // The first and only statement of a fresh first-primary session.
    const row = await this.#db.withSession('first-primary').prepare(META_SQL).bind(D1_SCHEMA_JSON, '{}').first<Raw>();
    this.#active(); need(row, 'authority');
    return this.#metadata(row);
  }
  #readJson(input: ReadInput) {
    return JSON.stringify({ actor: input.actor ?? null, channel: input.channel ?? null, id: input.id ?? null,
      target: input.target ?? null, history: input.history ? 1 : 0, capture: input.capture ? 1 : 0,
      inBatch: input.inBatch ? 1 : 0, records: this.#config.policy.history.records, bytes: this.#config.policy.history.bytes });
  }
  #decode(rows: Raw[], input: ReadInput, life: Lifetime): Snapshot {
    need(Array.isArray(rows) && rows.length <= this.#config.policy.history.records + 20, 'authority');
    const one = (kind: string): Raw | null => {
      const selected = rows.filter(r => r.kind === kind); need(selected.length <= 1, 'authority');
      return selected[0] ?? null;
    };
    const body = (r: Raw): Raw => {
      need(typeof r.body === 'string' && bytes(r.body) <= 16384, 'authority');
      const value: unknown = JSON.parse(r.body);
      need(value !== null && typeof value === 'object' && !Array.isArray(value), 'authority');
      return value as Raw;
    };
    const metadata = one('meta'); need(metadata, 'authority');
    const { meta, now } = this.#metadata(body(metadata), input.inBatch);
    this.#fresh(life, now); // Before decoding any returned payload.
    need(rows.every(r => ['meta', 'actor', 'channel', 'control', 'bounds', 'saved', 'root', 'history', 'capture', 'retired', 'affected'].includes(String(r.kind))), 'authority');
    const a = one('actor'), c = one('channel'), v = one('saved'), ctl = one('control');
    const result: Snapshot = { meta, now, actor: a ? agent(body(a)) : null, channel: c ? channel(body(c), this.#config) : null,
      saved: v ? saved(v) : null, control: ctl ? control(body(ctl), meta.revision) : null, history: null, capture: null };
    if (input.history && !result.saved && result.actor && result.channel?.enabled === 1 && publicChannel(result.channel)) {
      need(result.control, 'unsupported_history');
      const b = one('bounds'); need(b, 'authority');
      const bound = body(b), ct = result.control, p = this.#config.policy;
      need([bound.total, bound.total_bytes, bound.largest].every(safe), 'authority');
      const rootRow = one('root');
      // SQL returns no history payload at all on overflow, including the root.
      need(rootRow, 'history_capacity');
      const root = saved(rootRow), rootBytes = Number(rootRow.charge_bytes);
      need(root.env.channel === input.channel && root.env.type === 'poll' && payload(root.env).kind === 'open'
        && root.env.checksum === ct.root_hash && root.env.sender === ct.creator && ct.channel === input.channel
        && rootRow.public_key === ct.creator_key && safe(rootRow.registered_at), 'unsupported_history');
      need(Number(bound.total) + 1 + ct.reserve_records <= p.history.records
        && Number(bound.total_bytes) + rootBytes + ct.reserve_bytes <= p.history.bytes
        && Number(bound.largest) <= POLL_WORK_LIMITS.recordBytes, 'history_capacity');
      const creator: Agent = { agent_id: root.env.sender, public_key: ct.creator_key, registered_at: rootRow.registered_at,
        message_count: 0, last_seen: 0, wake_active: 0 };
      const records = [root.env], agents = new Map<string, Agent>([[creator.agent_id, creator]]);
      const history = rows.filter(r => r.kind === 'history').sort((a, b) => Number(a.stored_seq) - Number(b.stored_seq)
        || String(a.id).localeCompare(String(b.id)));
      need(history.length === bound.total, 'authority');
      let nodes = tree(root.env.payload) + (root.env.recipientKeys == null ? 0 : tree(root.env.recipientKeys));
      for (const r of history) {
        need(hex(r.public_key, 64) && r.public_key === r.public_key.toLowerCase() && safe(r.registered_at), 'authority');
        const env = decodeRow(stored(r));
        nodes += tree(env.payload) + (env.recipientKeys == null ? 0 : tree(env.recipientKeys));
        need(nodes + ct.reserve_nodes <= p.history.nodes, 'history_capacity');
        records.push(env); agents.set(env.sender, { agent_id: env.sender, public_key: r.public_key, registered_at: r.registered_at,
          message_count: 0, last_seen: 0, wake_active: 0 });
      }
      need(nodes + ct.reserve_nodes <= p.history.nodes, 'history_capacity');
      need(ct.history_records === records.length && ct.history_bytes === rootBytes + Number(bound.total_bytes)
        && ct.history_nodes === nodes, 'authority');
      result.history = { root: root.env, records, control: ct, agents };
    }
    if (input.capture) {
      const r = one('capture'); need(r, 'authority'); const v = body(r);
      need(safe(v.arrival_seq) && safe(v.wake_seq) && (v.owner === null || agentIdentifier(v.owner)), 'authority');
      const capture: Capture = { arrivalSeq: v.arrival_seq, wakeSeq: v.wake_seq, owner: v.owner, retired: [], channels: new Map() };
      for (const r of rows.filter(r => r.kind === 'retired')) {
        const v = body(r);
        need((v.journal === 'arrival' || v.journal === 'wake') && channelIdentifier(v.channel)
          && safe(v.charge_bytes) && v.charge_bytes <= CAPTURE_BYTES, 'authority');
        capture.retired.push({ journal: v.journal, channel: v.channel, charge_bytes: v.charge_bytes });
      }
      need(['arrival', 'wake'].every(j => capture.retired.filter(r => r.journal === j).length <= 1), 'authority');
      for (const r of rows.filter(r => r.kind === 'affected')) {
        const ch = channel(body(r), this.#config); need(!capture.channels.has(ch.name), 'authority'); capture.channels.set(ch.name, ch);
      }
      result.capture = capture;
    }
    this.#fresh(life, now);
    return result;
  }
  async #read(input: ReadInput, life: Lifetime) {
    const result = await this.#db.withSession('first-primary').prepare(SNAPSHOT_SQL).bind(D1_SCHEMA_JSON, this.#readJson(input)).all<Raw>();
    this.#active(); need(result.success, 'unavailable');
    return this.#decode(result.results, input, life);
  }
  async #charge(lane: Lane, started: number): Promise<Lifetime> {
    const { meta, now } = await this.#meta(), p = this.#config.policy;
    const window = Math.floor(now / p.windowMs);
    const attempts: ReturnType<typeof blankAttempts> = window === meta.window ? JSON.parse(meta.attempts_json) : blankAttempts();
    need(attempts[lane].requests < p.attempts[lane], 'attempt_capacity');
    const count = ++attempts[lane].requests;
    attempts[lane].input = count * p.wireBytes;
    attempts[lane].verification = count * (lane === 'recovery' ? 1 : 1 + p.history.records);
    const expiresAt = now + p.preparationMs; need(safe(expiresAt), 'clock');
    this.#fresh({ started, preparedAt: now, expiresAt }, now);
    const charged = await this.#db.withSession('first-primary').prepare(CHARGE_SQL).bind(D1_SCHEMA_JSON,
      JSON.stringify({ meta, window, attempts: canonicalizeJson(attempts), observedAt: now, expiresAt })).all<{ clock: number }>();
    this.#active(); need(charged.success && charged.results.length <= 1, 'unavailable');
    // A known zero-row CAS is a refusal, never a reusable permit or an automatic retry.
    need(charged.results.length === 1, 'busy');
    const preparedAt = charged.results[0].clock;
    need(safe(preparedAt) && preparedAt >= now && preparedAt >= this.#greatestClock, 'clock');
    this.#greatestClock = preparedAt;
    const life = { started, preparedAt, expiresAt };
    this.#fresh(life, preparedAt); // A late or lost charge cannot start protected work.
    return life;
  }

  async prepare(input: AdmissionInput, route: WriteRoute = {}): Promise<PreparedD1PollWrite> {
    route = { ...route };
    this.#enter();
    try {
      const lane = route.lane ?? 'ordinary'; need(lane === 'ordinary' || lane === 'completion', 'route');
      const life = await this.#charge(lane, performance.now());
      const wire = await readAdmissionInput(input);
      this.#fresh(life, life.preparedAt);
      const env = parseWire(wire, this.#config.policy);
      need(route.channel === undefined || route.channel === env.channel, 'route');
      const data = payload(env), close = env.type === 'poll' && data.kind === 'close';
      need(close ? lane === 'completion' && route.pollId === data.pollId : lane === 'ordinary' && route.pollId === undefined, 'route');
      const target = env.type === 'vote' || close ? data.pollId : null;
      need(target === null || messageIdentifier(target), 'invalid_payload');
      const validAction = fitsPollActionInput(env), encryption = encryptionError(env, false);
      const snapshot = await this.#read({ actor: env.sender, channel: env.channel, id: env.id, target,
        history: target !== null && validAction && !encryption }, life);
      need(snapshot.actor, 'signature');
      if (!snapshot.saved) {
        need(snapshot.channel?.enabled === 1 && publicChannel(snapshot.channel), 'channel');
        need(!encryption, 'encryption');
        need(validAction, 'input_limit');
      }
      need((await verifyEnvelope(env, snapshot.actor.public_key)).valid, 'signature'); this.#active();
      let before: PollTally | null = null;
      if (snapshot.saved) need(exact(snapshot.saved.env, env), 'operation_conflict');
      else if (env.type === 'poll' && data.kind === 'open') {
        need((data.closePolicy as { creator?: unknown } | undefined)?.creator === true && !Object.hasOwn(data, 'pollId'), 'unsupported_profile');
        refusal(checkPollIngest(env, null, null, { hub: this.#config.origin }).refusal);
      } else if (env.type === 'poll' || env.type === 'vote') {
        const h = snapshot.history; need(h, 'invalid_payload');
        before = await tallyPoll(h.root, h.records, async id => h.agents.get(id)?.public_key,
          { registeredAt: async id => h.agents.get(id)?.registered_at, now: life.preparedAt });
        this.#active();
        this.#eligibility(env, h, before, life.preparedAt, snapshot.actor);
      }
      const current = await this.#meta(); this.#fresh(life, current.now);
      const token = Object.freeze({});
      this.#prepared.set(token, { ...life, env, snapshot, target, close, before });
      return token;
    } catch (error) { return this.#fail(error); }
    finally { this.#inFlight--; }
  }
  #eligibility(env: Wire, h: History, before: PollTally | null, now: number, actor: Agent) {
    refusal(env.type === 'vote' ? checkVoteIngest(env, h.root, before,
      { hub: this.#config.origin, now, voterRegisteredAt: actor.registered_at })
      : checkPollIngest(env, h.root, before, { hub: this.#config.origin }).refusal);
  }
  async recover(input: AdmissionInput, channel?: string): Promise<ReceiptResult> {
    this.#enter();
    try {
      const life = await this.#charge('recovery', performance.now());
      const wire = await readAdmissionInput(input);
      this.#fresh(life, life.preparedAt);
      const env = parseWire(wire, this.#config.policy);
      need(channel === undefined || channel === env.channel, 'route');
      const initial = await this.#read({ actor: env.sender }, life), actor = initial.actor;
      need(actor && (await verifyEnvelope(env, actor.public_key)).valid, 'signature'); this.#active();
      const current = await this.#read({ actor: env.sender, channel: env.channel, id: env.id }, life);
      need(current.actor?.public_key === actor.public_key, 'authority');
      const result: ReceiptResult = current.saved ? receipt(current.saved, env, actor.public_key, current.channel, current.now, this.#config)
        : { outcome: 'unavailable', historical: true };
      this.#fresh(life, current.now); return result;
    } catch (error) { return this.#fail(error); }
    finally { this.#inFlight--; }
  }

  async commit(token: PreparedD1PollWrite): Promise<ReceiptResult> {
    this.#active(); const d = this.#prepared.get(token); need(d, 'unprepared');
    this.#prepared.delete(token); this.#enter();
    try {
      const { env, snapshot, target } = d, c = this.#config;
      const current = await this.#read({ actor: env.sender, channel: env.channel, id: env.id, target, capture: true }, d);
      const actor = current.actor, channel = current.channel;
      need(actor && actor.public_key === snapshot.actor?.public_key, 'authority');
      if (current.saved) {
        const result = receipt(current.saved, env, actor.public_key, channel, current.now, c);
        this.#fresh(d, current.now); return result;
      }
      need(!snapshot.saved, 'authority');
      need(channel?.enabled === 1 && current.meta.revision === snapshot.meta.revision
        && equal(channel, snapshot.channel) && equal(actor, snapshot.actor), 'stale');
      if (target !== null) {
        need(snapshot.history && current.control && equal(current.control, snapshot.history.control), 'stale');
        this.#eligibility(env, snapshot.history, d.before, current.now, actor);
      }
      const plan = proposal(d, current, c), capture = current.capture!;
      const closes = snapshot.history ? payload(snapshot.history.root).closes as { at?: number } | undefined : undefined;
      const deadline = env.type === 'vote' ? closes?.at ?? null : null;
      const stage = { id: env.id, preparedAt: d.preparedAt, expiresAt: d.expiresAt, observedAt: current.now, deadline,
        before: { meta: current.meta, actor, channel, control: current.control }, expected: plan.expected,
        arrivalSeq: capture.arrivalSeq, wakeSeq: capture.wakeSeq, owner: capture.owner, affected: [...capture.channels.values()] };
      const session = this.#db.withSession('first-primary');
      const statements: D1PreparedStatement[] = [];
      const add = (sql: string, ...args: SqlValue[]) => statements.push(session.prepare(sql).bind(...args));
      add(STAGE_SQL + ' RETURNING message_id', D1_SCHEMA_JSON, JSON.stringify(stage));
      const window = Math.floor(current.now / c.policy.windowMs);
      add(ADVANCE_CLOCK_SQL, current.now, window,
        window === current.meta.window ? current.meta.attempts_json : canonicalizeJson(blankAttempts()), env.id);
      if (plan.control) {
        if (plan.root) add(`INSERT INTO poll_admission_controls (${controlFields.join(',')})
          SELECT ${controlFields.map(() => '?').join(',')} WHERE ${ADMITTED}`,
        ...controlFields.map(k => plan.control![k]), env.id);
        else {
          const fields = ['revision', 'close_recorded', 'reserved_rows', 'reserved_bytes', 'reserve_records', 'reserve_bytes',
            'reserve_nodes', 'history_records', 'history_bytes', 'history_nodes'] as const;
          add(`UPDATE poll_admission_controls SET ${fields.map(k => k + ' = ?').join(',')}
            WHERE root_id = ? AND revision = ? AND ${ADMITTED}`,
          ...fields.map(k => plan.control![k]), target!, current.control!.revision, env.id);
        }
      }
      add(`INSERT INTO messages (${wireColumns.join(',')}) SELECT ${wireColumns.map(() => '?').join(',')} WHERE ${ADMITTED}`,
        ...wireColumns.map(k => plan.row[k]), env.id);
      add(`INSERT INTO poll_admission_receipts (message_id, channel, actor_key, receipt_json) SELECT ?, ?, ?, ? WHERE ${ADMITTED}`,
        env.id, env.channel, actor.public_key, plan.receiptJson, env.id);
      add(`UPDATE channels SET high_seq = high_seq + 1, message_count = message_count + 1, revision = revision + 1 WHERE name = ? AND ${ADMITTED}`,
        env.channel, env.id);
      add(`UPDATE agents SET message_count = message_count + 1, last_seen = ? WHERE agent_id = ? AND ${ADMITTED}`,
        current.now, env.sender, env.id);
      add(`UPDATE poll_admission_authority SET revision = revision + 1 WHERE id = 1 AND revision = ? AND ${ADMITTED}`,
        current.meta.revision, env.id);
      const readInput = { actor: env.sender, channel: env.channel, id: env.id, inBatch: true };
      add(SNAPSHOT_SQL, D1_SCHEMA_JSON, this.#readJson(readInput));
      // LAST statement. An ignored mutation, expired decision or bad final ledger
      // aborts the whole batch. Interpret no earlier result before this resolves.
      add('DELETE FROM poll_admission_guard WHERE id = 1 RETURNING id');
      this.#fresh(d, current.now);
      const results = await session.batch<Raw>(statements);
      this.#active();
      if (performance.now() - d.started > c.policy.preparationMs) return this.#break();
      need(results.length === statements.length && results.every(r => r.success), 'unavailable');
      const staged = results[0].results;
      need(staged.length <= 1 && staged.every(r => r.message_id === env.id), 'authority');
      const deleted = results[results.length - 1].results;
      need(deleted.length === staged.length && deleted.every(r => r.id === 1), 'authority');
      const final = this.#decode(results[results.length - 2].results, readInput, d);
      need(final.actor?.public_key === actor.public_key, 'authority');
      if (!final.saved) { need(staged.length === 0, 'authority'); throw new PollAdmissionError('stale'); }
      const result = receipt(final.saved, env, actor.public_key, final.channel, final.now, c);
      if (performance.now() - d.started > c.policy.preparationMs) return this.#break();
      // A concurrent exact replay is resolved from the batch's primary snapshot.
      if (staged.length === 1) {
        need(final.saved.receiptJson === plan.receiptJson, 'authority');
        // A new writer receives its own ACK, including encrypted intel. Later
        // historical recovery/replay still requires current public visibility.
        return { outcome: 'found', receipt: plan.receipt, historical: true, replayed: false };
      }
      return result;
    } catch (error) { return this.#fail(error); }
    finally { this.#inFlight--; }
  }
}
