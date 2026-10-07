import type { D1Database } from '@cloudflare/workers-types';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson } from '@openagentforum/protocol';
import { PUBLIC_WRITE_BUDGET_SCHEMA, PUBLIC_WRITE_BUDGET_DB_NOW, PUBLIC_WRITE_COSTS,
  createD1PublicWriteAdmission, publicWriteBudgetSeed, PublicWriteBudgetError,
  type PublicWriteBudgetOptions, type PublicWriteOperation } from '../src/public-write-budget.js';
import { createSQLitePublicWriteAdmission } from '../src/public-write-budget-sqlite.js';
import { readPublicWriteInput } from '../src/public-write-input.js';

const options = (requests = 4): PublicWriteBudgetOptions => ({
  origin: 'https://relay.test', generation: 'a'.repeat(64), policy: {
    windowMs: 60000, ordinary: { requests, inputBytes: 1024 * 1024 }, completion: { requests: 2, inputBytes: 512 * 1024 },
    operations: { registration: requests, channel: requests, message: requests,
      'task-create': requests, 'task-claim': requests, 'task-submit': 2 },
  },
});
const request = (body: BodyInit = '{}', signal?: AbortSignal) => new Request('https://relay.test/v1/channels', {
  method: 'POST', body, headers: { 'content-type': 'application/json' }, signal, duplex: 'half',
} as RequestInit);
const databases: DatabaseSync[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
function fixture(config = options()) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let clock = 1_800_000, readHook: ((row: Record<string, unknown> | undefined) => Promise<void>) | undefined;
  let batchHook: ((rows: unknown[]) => Promise<void>) | undefined;
  let reads = 0, batches = 0, sessions = 0;
  const prepare = db.prepare.bind(db);
  db.function('budget_fixture_now', () => clock);
  vi.spyOn(db, 'prepare').mockImplementation(sql => prepare(sql.replaceAll(PUBLIC_WRITE_BUDGET_DB_NOW, 'budget_fixture_now()')));
  db.exec(PUBLIC_WRITE_BUDGET_SCHEMA);
  const seed = publicWriteBudgetSeed(config);
  db.prepare('INSERT INTO public_write_request_budget VALUES (1, 1, ?, ?, ?, ?)')
    .run(seed.origin, seed.generation, seed.policy, seed.state);
  const state = () => JSON.parse(db.prepare('SELECT state_json FROM public_write_request_budget').get()!.state_json as string);
  const d1 = { withSession(mode: string) {
    expect(mode).toBe('first-primary'); sessions++;
    const statement = (sql: string, args: SQLInputValue[] = []) => ({
      sql, args, bind: (...values: SQLInputValue[]) => statement(sql, values),
      first: async () => { reads++; const row = db.prepare(sql).get(...args); await readHook?.(row); return row ?? null; },
    });
    return { prepare: (sql: string) => statement(sql), batch: async (statements: { sql: string; args: SQLInputValue[] }[]) => {
      batches++; db.exec('BEGIN IMMEDIATE'); let rows;
      try { rows = statements.map(stmt => ({ success: true, results: db.prepare(stmt.sql).all(...stmt.args) })); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      await batchHook?.(rows); return rows;
    } };
  } } as unknown as D1Database;
  return { db, d1, state, config, setClock: (n: number) => { clock = n; }, clock: () => clock,
    hooks: (read?: typeof readHook, batch?: typeof batchHook) => { readHook = read; batchHook = batch; },
    counts: () => ({ reads, batches, sessions }),
    gate: (adapter: 'SQLite' | 'D1', custom = config) => adapter === 'SQLite'
      ? createSQLitePublicWriteAdmission(db, custom) : createD1PublicWriteAdmission(d1, custom),
  };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describe.each(['SQLite', 'D1'] as const)('%s shared public write request accounting', adapter => {
  it('shares fixed allowance across identities, operations and new gate instances, before body reading', async () => {
    const f = fixture(options(3)); let bodies = 0;
    for (const op of ['registration', 'channel', 'task-create'] as PublicWriteOperation[]) {
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        bodies++; expect(f.state().ordinary.requests).toBe(bodies);
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ creatorId: `new-key-${bodies}` }))); controller.close();
      } }, { highWaterMark: 0 });
      const req = request(body);
      await f.gate(adapter).run(req, op, async () => { await req.json(); });
    }
    let cancelled = false;
    const blocked = request(new ReadableStream({ pull() { throw new Error('must not read'); }, cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 }));
    const work = vi.fn();
    await expect(f.gate(adapter).run(blocked, 'message', work)).rejects.toMatchObject({ code: 'public_write_rate_limited', status: 429 });
    expect(work).not.toHaveBeenCalled(); expect(cancelled).toBe(true);
    expect(f.state().ordinary).toEqual({ requests: 3, inputBytes: 16384 + 16384 + 49152 });
    expect(f.db.prepare('SELECT count(*) AS n FROM public_write_request_budget').get()!.n).toBe(1);
  });

  it('counts malformed/oversized bodies and failed work without refunds; completion has its own finite lane', async () => {
    const f = fixture(options(2)); const gate = f.gate(adapter);
    for (const raw of ['{', ' '.repeat(PUBLIC_WRITE_COSTS.channel + 1)]) {
      const req = request(raw);
      await expect(gate.run(req, 'channel', () => readPublicWriteInput(req, 'channel'))).rejects.toBeDefined();
    }
    await expect(gate.run(request(), 'registration', async () => {})).rejects.toMatchObject({ status: 429 });
    await expect(gate.run(request(), 'task-submit', async () => { throw new Error('work failed'); })).rejects.toThrow('work failed');
    await gate.run(request(), 'task-submit', async () => {});
    await expect(gate.run(request(), 'task-submit', async () => {})).rejects.toMatchObject({ status: 429 });
    expect(f.state().completion).toEqual({ requests: 2, inputBytes: 2 * PUBLIC_WRITE_COSTS['task-submit'] });
  });

  it('enforces byte and operation allowances, with bounded no-store errors that never reflect peer data', async () => {
    const config = options(); config.policy.ordinary = { requests: 4, inputBytes: 262144 };
    config.policy.operations = { ...config.policy.operations, channel: 1 };
    const f = fixture(config); const gate = f.gate(adapter);
    await gate.run(request(), 'channel', async () => {});
    for (const op of ['channel', 'message'] as const) {
      const error = await gate.run(request(), op, async () => {}).catch(e => e);
      expect(error).toBeInstanceOf(PublicWriteBudgetError);
      const response = error.getResponse();
      expect(response.status).toBe(429); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('retry-after')).toBe('60');
      expect(await response.json()).toEqual({ error: 'public_write_rate_limited', code: 'public_write_rate_limited' });
    }
    expect(f.state().ordinary.requests).toBe(1);
  });

  it('rolls request windows using database time, preserves counts across instances, and refuses clock rollback', async () => {
    const f = fixture(options(1));
    await f.gate(adapter).run(request(), 'channel', async () => {});
    await expect(f.gate(adapter).run(request(), 'channel', async () => {})).rejects.toMatchObject({ status: 429 });
    f.setClock(f.clock() + 60000);
    await f.gate(adapter).run(request(), 'channel', async () => {});
    expect(f.state().ordinary.requests).toBe(1);
    const gate = f.gate(adapter); const before = f.state();
    f.setClock(f.clock() - 60000);
    await expect(gate.run(request(), 'channel', async () => {})).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
    f.setClock(f.clock() + 120000);
    await expect(gate.run(request(), 'channel', async () => {})).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
    expect(f.state()).toEqual(before);
  });

  it('fails closed on missing/corrupt authority, origin, policy and generation; never repairs or initializes it', async () => {
    for (const damage of ['row', 'table', 'json', 'counter', 'origin', 'generation', 'policy']) {
      const f = fixture(); let config = f.config;
      if (damage === 'row') f.db.exec('DELETE FROM public_write_request_budget');
      if (damage === 'table') f.db.exec('DROP TABLE public_write_request_budget');
      if (damage === 'json') f.db.prepare('UPDATE public_write_request_budget SET state_json = ?').run('{"private":');
      if (damage === 'counter') { const state = f.state(); state.ordinary.requests = 1; f.db.prepare('UPDATE public_write_request_budget SET state_json = ?').run(canonicalizeJson(state)); }
      if (damage === 'origin') config = { ...config, origin: 'https://other.test' };
      if (damage === 'generation') config = { ...config, generation: 'b'.repeat(64) };
      if (damage === 'policy') config = { ...config, policy: { ...config.policy, windowMs: 30000 } };
      const work = vi.fn(); await expect(f.gate(adapter, config).run(request(), 'message', work)).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
      expect(work).not.toHaveBeenCalled();
      if (damage === 'row') expect(f.db.prepare('SELECT count(*) AS n FROM public_write_request_budget').get()!.n).toBe(0);
      if (damage === 'table') expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'public_write_request_budget'").get()).toBeUndefined();
    }
  });

  it('snapshots policy and rejects non-POST, already aborted or unknown operations without accounting', async () => {
    const f = fixture(); const gate = f.gate(adapter); f.config.policy.ordinary = { requests: 1, inputBytes: 262144 };
    await gate.run(request(), 'message', async () => {}); await gate.run(request(), 'message', async () => {});
    const abort = new AbortController(); abort.abort();
    for (const [req, op] of [[new Request('https://relay.test'), 'message'], [request('{}', abort.signal), 'channel'], [request(), '__proto__']] as const) {
      await expect(gate.run(req, op as PublicWriteOperation, async () => {})).rejects.toMatchObject({ status: 400 });
    }
    expect(f.state().ordinary.requests).toBe(2);
  });
});

describe('primary D1 reservation races and uncertainty', () => {
  it.each([1, 2])('replans an acknowledged same-snapshot race with allowance %i without overspending', async capacity => {
    const f = fixture(options(capacity)); const barrier = deferred(); let reached = 0;
    f.hooks(async () => { if (++reached === 2) barrier.resolve(); if (reached <= 2) await barrier.promise; });
    const work = vi.fn(async () => true);
    const results = await Promise.allSettled([f.gate('D1').run(request(), 'channel', work), f.gate('D1').run(request(), 'channel', work)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(capacity);
    expect(work).toHaveBeenCalledTimes(capacity); expect(f.state().ordinary.requests).toBe(capacity);
    expect(f.counts().batches).toBe(capacity === 1 ? 2 : 3);
    expect(f.counts().sessions).toBe(f.counts().reads + f.counts().batches);
  });

  it('never retries a lost committed acknowledgment or grants work from it; the reservation remains spent', async () => {
    const f = fixture(options(2)); f.hooks(undefined, async () => { throw new Error('private storage diagnostic'); });
    const gate = f.gate('D1'), work = vi.fn();
    const error = await gate.run(request(), 'message', work).catch(e => e);
    expect(error.message).toBe('public_write_budget_unavailable'); expect(work).not.toHaveBeenCalled();
    expect(f.state().ordinary.requests).toBe(1); expect(f.counts().batches).toBe(1);
    f.hooks();
    await expect(gate.run(request(), 'message', work)).rejects.toMatchObject({ status: 503 });
    await f.gate('D1').run(request(), 'message', async () => {});
    await expect(f.gate('D1').run(request(), 'message', work)).rejects.toMatchObject({ status: 429 });
  });

  it('caps CAS contention at three attempts, and never starts work after a window changes', async () => {
    const f = fixture(); const seed = publicWriteBudgetSeed(f.config); let n = 0;
    f.hooks(async () => { const state = JSON.parse(seed.state); state.clock = f.clock() + ++n; state.bucket = Math.floor(state.clock / f.config.policy.windowMs);
      f.db.prepare('UPDATE public_write_request_budget SET state_json = ?').run(canonicalizeJson(state)); f.setClock(state.clock); });
    const work = vi.fn();
    await expect(f.gate('D1').run(request(), 'channel', work)).rejects.toMatchObject({ code: 'public_write_budget_busy' });
    expect(f.counts().batches).toBe(3); expect(work).not.toHaveBeenCalled();
    const g = fixture(); g.hooks(async () => { g.setClock(g.clock() + 60000); });
    await expect(g.gate('D1').run(request(), 'channel', work)).rejects.toMatchObject({ code: 'public_write_budget_busy' });
    expect(g.counts().batches).toBe(1); expect(g.state().ordinary.requests).toBe(0);
  });

  it.each(['timeout', 'abort'] as const)('cancels %s while primary storage is pending and never starts late work', async kind => {
    vi.useFakeTimers(); const f = fixture(); const wait = deferred(); f.hooks(async () => wait.promise);
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 });
    const abort = new AbortController(), work = vi.fn();
    const gate = f.gate('D1'); const result = gate.run(request(body, abort.signal), 'message', work).catch(e => e);
    if (kind === 'abort') abort.abort(); else await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ code: 'public_write_budget_unavailable' });
    expect(cancelled).toBe(true); wait.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(work).not.toHaveBeenCalled(); expect(f.counts().batches).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds local in-flight work without reusable reservations', async () => {
    const f = fixture(options(12)); const wait = deferred(); const gate = f.gate('D1');
    const started: Promise<unknown>[] = [];
    // Sequential reservation starts make this a local-cap test, not a CAS contention test.
    for (let i = 0; i < 8; i++) { const arrived = deferred(); started.push(gate.run(request(), 'channel', async () => { arrived.resolve(); await wait.promise; }).catch(e => e)); await arrived.promise; }
    await expect(gate.run(request(), 'channel', async () => {})).rejects.toMatchObject({ code: 'public_write_budget_busy' });
    expect(f.state().ordinary.requests).toBe(8); wait.resolve(); await Promise.all(started);
    f.hooks(undefined, async () => { throw new Error(); });
    await expect(gate.run(request(), 'channel', async () => {})).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
    f.hooks(); await expect(gate.run(request(), 'channel', async () => {})).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
  });

  it('keeps a late committed reservation spent after timeout and never starts its callback', async () => {
    vi.useFakeTimers(); const f = fixture(); const wait = deferred(), committed = deferred();
    f.hooks(undefined, async () => { committed.resolve(); await wait.promise; });
    const work = vi.fn(), gate = f.gate('D1');
    const result = gate.run(request(), 'channel', work).catch(e => e);
    await committed.promise; expect(f.state().ordinary.requests).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ code: 'public_write_budget_unavailable' });
    wait.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(work).not.toHaveBeenCalled(); expect(f.counts().batches).toBe(1);
    f.hooks(); await f.gate('D1').run(request(), 'channel', async () => {});
    expect(f.state().ordinary.requests).toBe(2);
  });

  it('does not report successful work after a concurrent reservation poisons the instance', async () => {
    const f = fixture(); const gate = f.gate('D1'), arrived = deferred(), finish = deferred();
    const result = gate.run(request(), 'channel', async () => { arrived.resolve(); await finish.promise; return 'committed'; }).catch(e => e);
    await arrived.promise;
    f.hooks(undefined, async rows => { rows.length = 0; });
    await expect(gate.run(request(), 'channel', async () => {})).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
    finish.resolve(); expect(await result).toMatchObject({ code: 'public_write_budget_unavailable' });
    expect(f.state().ordinary.requests).toBe(2); expect(f.counts().batches).toBe(2);
  });

  it('does not forget an observed database clock after an acknowledged zero-row CAS', async () => {
    const f = fixture(), work = vi.fn();
    // The first CAS misses its time guard. Retained state is unchanged, but the
    // next primary read must still reject the clock observed by this operation.
    f.hooks(async () => { f.setClock(f.clock() - 1); });
    await expect(f.gate('D1').run(request(), 'channel', work)).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
    expect(f.counts().batches).toBe(1); expect(f.state().ordinary.requests).toBe(0);
    expect(work).not.toHaveBeenCalled();
  });

  it.each(['state', 'clock', 'extra-row', 'unsuccessful'] as const)('rejects a mismatched %s acknowledgment without retrying the committed reservation', async damage => {
    const f = fixture(), work = vi.fn();
    f.hooks(undefined, async rows => {
      const result = rows[0] as { success: boolean; results: { state_json: string; db_now: number }[] };
      if (damage === 'state') result.results[0].state_json = '{}';
      if (damage === 'clock') result.results[0].db_now = f.clock() + 60000;
      if (damage === 'extra-row') result.results.push(result.results[0]);
      if (damage === 'unsuccessful') result.success = false;
    });
    const error = await f.gate('D1').run(request(), 'channel', work).catch(e => e);
    expect(error).toMatchObject({ code: 'public_write_budget_unavailable' });
    expect(error.getResponse().headers.get('retry-after')).toBeNull();
    expect(f.counts().batches).toBe(1); expect(f.state().ordinary.requests).toBe(1);
    expect(work).not.toHaveBeenCalled();
  });

  it('catches an abort during initial storage invocation before any pending read resolves', async () => {
    const f = fixture(), wait = deferred(), abort = new AbortController(), work = vi.fn();
    f.hooks(async () => { abort.abort(); await wait.promise; });
    const gate = f.gate('D1');
    const result = await gate.run(request('{}', abort.signal), 'channel', work).catch(e => e);
    expect(result).toMatchObject({ code: 'public_write_budget_unavailable' });
    expect(work).not.toHaveBeenCalled(); expect(f.counts().batches).toBe(0);
    f.hooks();
    await gate.run(request(), 'channel', async () => {});
    wait.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect(work).not.toHaveBeenCalled(); expect(f.state().ordinary.requests).toBe(1);
    expect(f.counts().batches).toBe(1);
  });

  it('keeps a committed reservation spent after caller abort while the same gate serves later requests', async () => {
    const f = fixture(options(2)), wait = deferred(), committed = deferred(), abort = new AbortController(), work = vi.fn();
    f.hooks(undefined, async () => { committed.resolve(); await wait.promise; });
    const gate = f.gate('D1');
    const cancelled = gate.run(request('{}', abort.signal), 'channel', work).catch(e => e);
    await committed.promise; abort.abort();
    expect(await cancelled).toMatchObject({ code: 'public_write_budget_unavailable' });
    expect(f.state().ordinary.requests).toBe(1); expect(work).not.toHaveBeenCalled();
    f.hooks(); await gate.run(request(), 'channel', async () => {});
    wait.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect(work).not.toHaveBeenCalled(); expect(f.state().ordinary.requests).toBe(2);
    await expect(gate.run(request(), 'channel', work)).rejects.toMatchObject({ code: 'public_write_rate_limited' });
    expect(f.counts().batches).toBe(2);
  });

  it.each(['throw', 'malformed'] as const)('still poisons on a real late %s storage failure after caller cancellation', async failure => {
    const f = fixture(), wait = deferred(), committed = deferred(), abort = new AbortController(), work = vi.fn();
    f.hooks(undefined, async rows => {
      committed.resolve(); await wait.promise;
      if (failure === 'throw') throw new Error('fixture storage failure');
      rows.length = 0;
    });
    const gate = f.gate('D1');
    const cancelled = gate.run(request('{}', abort.signal), 'channel', work).catch(e => e);
    await committed.promise; abort.abort(); await cancelled;
    wait.resolve(); await new Promise(resolve => setImmediate(resolve));
    f.hooks();
    await expect(gate.run(request(), 'channel', work)).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
    expect(work).not.toHaveBeenCalled(); expect(f.counts().batches).toBe(1);
  });

  it('keeps aborted but unsettled reservations in the local in-flight cap and releases them on settlement', async () => {
    const f = fixture(), wait = deferred(), work = vi.fn();
    f.hooks(async () => wait.promise); const gate = f.gate('D1');
    for (let i = 0; i < 8; i++) {
      const abort = new AbortController();
      const cancelled = gate.run(request('{}', abort.signal), 'channel', work).catch(e => e);
      abort.abort(); expect(await cancelled).toMatchObject({ code: 'public_write_budget_unavailable' });
    }
    await expect(gate.run(request(), 'channel', work)).rejects.toMatchObject({ code: 'public_write_budget_busy' });
    expect(f.counts().reads).toBe(8); expect(f.counts().batches).toBe(0);
    f.hooks(); wait.resolve(); await new Promise(resolve => setImmediate(resolve));
    await gate.run(request(), 'channel', work);
    expect(work).toHaveBeenCalledTimes(1); expect(f.state().ordinary.requests).toBe(1);
  });

  it('does not discard another admitted callback when a different request is aborted', async () => {
    const f = fixture(), gate = f.gate('D1'), arrived = deferred(), finish = deferred(), wait = deferred();
    const healthy = gate.run(request(), 'channel', async () => { arrived.resolve(); await finish.promise; return 'committed'; });
    await arrived.promise;
    f.hooks(async () => wait.promise); const abort = new AbortController();
    const cancelled = gate.run(request('{}', abort.signal), 'channel', async () => { throw new Error('must not start'); }).catch(e => e);
    abort.abort(); await cancelled;
    finish.resolve(); expect(await healthy).toBe('committed');
    wait.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect(f.state().ordinary.requests).toBe(1);
  });
});

it('rolls back a cancelled synchronous SQLite reservation and keeps the same wrapper usable', async () => {
  const f = fixture(), abort = new AbortController(), work = vi.fn(), gate = f.gate('SQLite');
  const exec = f.db.exec.bind(f.db); let first = true;
  vi.spyOn(f.db, 'exec').mockImplementation(sql => {
    const result = exec(sql);
    if (sql === 'BEGIN IMMEDIATE' && first) { first = false; abort.abort(); }
    return result;
  });
  await expect(gate.run(request('{}', abort.signal), 'channel', work)).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
  expect(f.state().ordinary.requests).toBe(0); expect(work).not.toHaveBeenCalled();
  await gate.run(request(), 'channel', work);
  expect(f.state().ordinary.requests).toBe(1); expect(work).toHaveBeenCalledTimes(1);
});

it('checks the monotonic deadline after synchronous SQLite stalls, without relying on timer delivery', async () => {
  const f = fixture(), work = vi.fn(); let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, 'exec').mockImplementation(sql => {
    const result = exec(sql); if (sql === 'BEGIN IMMEDIATE') elapsed = 5000; return result;
  });
  await expect(f.gate('SQLite').run(request(), 'channel', work)).rejects.toMatchObject({ code: 'public_write_budget_unavailable' });
  expect(f.state().ordinary.requests).toBe(0); expect(work).not.toHaveBeenCalled();
  // The transaction was rolled back, not left holding a lock after the deadline.
  exec('BEGIN IMMEDIATE'); exec('ROLLBACK');
});

it('shares SQLite allowances across independent processes and keeps reservations after process exit', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'oaf-write-budget-'));
  const db = new DatabaseSync(join(scratch, 'budget.sqlite'));
  const config = options(2);
  config.policy.windowMs = 86_400_000;
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(PUBLIC_WRITE_BUDGET_SCHEMA);
    db.exec('CREATE TABLE fixture_work (id INTEGER PRIMARY KEY)');
    const seed = publicWriteBudgetSeed(config);
    db.prepare('INSERT INTO public_write_request_budget VALUES (1, 1, ?, ?, ?, ?)')
      .run(seed.origin, seed.generation, seed.policy, seed.state);
    const child = (stop = '') => promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('./fixtures/public-write-budget-child.mjs', import.meta.url)), join(scratch, 'budget.sqlite'), JSON.stringify(config), stop],
      { timeout: 10000, maxBuffer: 4096 });
    const exited = await child('stop');
    expect(exited.stdout).toBe('');
    expect(db.prepare('SELECT count(*) AS n FROM fixture_work').get()!.n).toBe(0);
    const results = (await Promise.all([child(), child()])).map(result => JSON.parse(result.stdout));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)[0].code).toMatch(/^public_write_(rate_limited|budget_unavailable)$/);
    expect(JSON.parse((await child()).stdout)).toEqual({ ok: false, code: 'public_write_rate_limited' });
    expect(db.prepare('SELECT count(*) AS n FROM fixture_work').get()!.n).toBe(1);
    const state = JSON.parse(db.prepare('SELECT state_json FROM public_write_request_budget').get()!.state_json as string);
    expect(state.ordinary).toEqual({ requests: 2, inputBytes: 32768 });
  } finally { db.close(); await rm(scratch, { recursive: true, force: true }); }
}, 20000);
