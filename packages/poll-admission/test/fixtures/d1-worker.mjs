// Disposable local test fixture only. Never a Pages route or production Worker.
import { canonicalizeJson } from '@openagentforum/protocol';
import { D1PollAdmission } from '../../src/d1.ts';
import { D1_SCHEMA_OBJECTS, CHARGE_SQL, SNAPSHOT_SQL, META_SQL } from '../../src/d1-sql.ts';
import { blankAttempts } from '../../src/d1-state.ts';
import { FIXED_ROW_BYTES, GUARD_ROW_BYTES } from '../../src/contract.ts';
import { DB_NOW } from '../../src/schema.ts';
import { createD1PollStore, computeTally } from '@openagentforum/server/polls';
import { createD1PollHttpHandler } from '../../../../apps/web/functions/_lib/poll-admission-http.ts';

const tables = ['poll_admission_authority', 'agents', 'channels', 'messages', 'poll_admission_controls',
  'poll_admission_receipts', 'public_recent_state', 'wake_recent_state', 'public_message_arrivals', 'wake_message_outbox', 'poll_admission_guard'];
const caught = async operation => {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, code: error.code ?? 'fixture_error' }; }
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function binding(db, input, trace) {
  const bound = new WeakMap();
  let snapshotReads = 0;
  return { withSession(constraint) {
    if (constraint !== 'first-primary') throw new Error('Fixture requires primary');
    trace.sessions++;
    const session = db.withSession(constraint); let executed = false;
    const execute = () => { if (executed) throw new Error('Session was reused'); executed = true; };
    function wrap(statement, sql, args = []) {
      const wrapper = {
        bind(...values) { return wrap(statement.bind(...values), sql, values); },
        async first() { execute(); trace.reads++; return statement.first(); },
        async all() {
          execute(); const charge = sql === CHARGE_SQL;
          if (charge) trace.charges++; else trace.reads++;
          if (charge && input.fault === 'charge-before') throw new Error('Fixture charge failure');
          const result = await statement.all();
          if (charge && input.fault === 'charge-after') throw new Error('Fixture lost charge response');
          if (charge && input.fault === 'charge-late') await wait(input.options.policy.preparationMs + 20);
          if (sql === SNAPSHOT_SQL) {
            snapshotReads++;
            trace.snapshots.push({ rows: result.results.length, records: result.results.filter(r => r.kind === 'history' || r.kind === 'root').length });
            if (input.afterRead && snapshotReads === input.afterRead.number) await db.prepare(input.afterRead.sql).bind(...(input.afterRead.args ?? [])).run();
            if (input.fault === 'read-late') await wait(input.options.policy.preparationMs + 20);
          }
          return result;
        },
      };
      bound.set(wrapper, { statement, sql, args }); return wrapper;
    }
    return { prepare(sql) { return wrap(session.prepare(sql), sql); }, async batch(statements) {
      execute(); trace.batches++;
      const entries = statements.map(s => bound.get(s));
      if (entries.some(s => !s)) throw new Error('Fixture foreign statement');
      if (entries.at(-1).sql !== 'DELETE FROM poll_admission_guard WHERE id = 1 RETURNING id') throw new Error('Guard must be last');
      let native = entries.map(s => s.statement);
      if (input.beforeBatch) await db.prepare(input.beforeBatch.sql).bind(...(input.beforeBatch.args ?? [])).run();
      if (input.failAfter !== undefined) native.splice(input.failAfter + 1, 0, session.prepare("SELECT json('fixture failure')"));
      if (input.skipStatement !== undefined) native[input.skipStatement] = session.prepare('SELECT 1');
      if (input.beforeFinal) native.splice(-1, 0, session.prepare(input.beforeFinal.sql).bind(...(input.beforeFinal.args ?? [])));
      if (input.fault === 'batch-late-before') await wait(input.options.policy.preparationMs + 20);
      let results;
      try { results = await session.batch(native); }
      catch (error) { trace.failedBatch = true; throw error; }
      if (input.beforeFinal) results.splice(-2, 1);
      if (input.fault === 'batch-after') throw new Error('Fixture lost committed response');
      if (input.fault === 'batch-late-after') await wait(input.options.policy.preparationMs + 20);
      return results;
    } };
  } };
}

export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/test-only/')) return new Response(null, { status: 404 });
  const input = await request.json(); // Parent-owned, bounded synthetic material.
  if (path === '/test-only/init') {
    const config = input.options, statements = D1_SCHEMA_OBJECTS.map(o => env.DB.prepare(o.sql));
    for (const actor of input.actors) statements.push(env.DB.prepare('INSERT INTO agents VALUES (?, ?, ?, 0, 0, 1)')
      .bind(actor.id, actor.key, input.now - 100));
    for (const name of input.channels) statements.push(env.DB.prepare("INSERT INTO channels VALUES (?, 0, 0, '[]', 1, 0, 0, 0, 1, ?, 0, 0)").bind(name, FIXED_ROW_BYTES));
    statements.push(env.DB.prepare('INSERT INTO public_recent_state VALUES (1, 0)'), env.DB.prepare('INSERT INTO wake_recent_state VALUES (1, 0)'));
    statements.push(env.DB.prepare('INSERT INTO poll_admission_authority VALUES (1, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, 0)')
      .bind(config.origin, config.generation, config.policyRevision, canonicalizeJson(config.policy), input.now,
        Math.floor(input.now / config.policy.windowMs), canonicalizeJson(blankAttempts()), 4 + input.actors.length + input.channels.length,
        (3 + input.actors.length + input.channels.length) * FIXED_ROW_BYTES + GUARD_ROW_BYTES));
    await env.DB.batch(statements); return Response.json({ initialized: true });
  }
  if (path === '/test-only/inspect') {
    const result = {};
    for (const table of tables) result[table] = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
    result.foreign_keys = (await env.DB.prepare('PRAGMA foreign_key_check').all()).results;
    return Response.json(result);
  }
  if (path === '/test-only/sql') {
    try { return Response.json(await env.DB.prepare(input.sql).bind(...(input.args ?? [])).all()); }
    catch (error) { return Response.json({ fixtureSqlError: String(error.message).slice(0, 500) }); }
  }
  if (path === '/test-only/clock') {
    const results = await env.DB.batch([env.DB.prepare(`SELECT ${DB_NOW} AS now`),
      env.DB.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n'),
      env.DB.prepare(`SELECT ${DB_NOW} AS now`)]);
    return Response.json({ first: results[0].results[0].now, last: results[2].results[0].now });
  }
  if (path === '/test-only/hosted-tally') {
    const store = createD1PollStore(env.DB), root = await store.getPoll(input.channel, input.id);
    return Response.json((await computeTally(store, root, { now: input.now })).tally);
  }
  const trace = { sessions: 0, reads: 0, charges: 0, batches: 0, snapshots: [] };
  const store = new D1PollAdmission(binding(env.DB, input, trace), input.options);
  if (path === '/test-only/http') {
    const handler = createD1PollHttpHandler(binding(env.DB, input, trace), {
      ...input.options, bodyTimeoutMs: input.bodyTimeoutMs ?? 1000,
    });
    let pulls = 0, cancelled = false;
    const data = input.body ?? '';
    const body = input.stream === 'stalled' ? new ReadableStream({ pull() { pulls++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 })
      : input.stream === 'invalid-utf8' ? new Uint8Array([0xc0, 0xaf])
      : input.stream === 'chunks' ? new ReadableStream({ pull(controller) {
        pulls++; if (pulls <= 4100) controller.enqueue(new Uint8Array()); else controller.close();
      }, cancel() { cancelled = true; } }, { highWaterMark: 0 })
      : input.stream === 'observed' ? new ReadableStream({ pull(controller) {
        pulls++; controller.enqueue(new TextEncoder().encode(data)); controller.close();
      }, cancel() { cancelled = true; } }, { highWaterMark: 0 }) : data;
    const method = input.method ?? 'POST';
    const request = new Request(`${input.options.origin}${input.path ?? '/v1/channels/general/messages'}`, {
      method, headers: { 'content-type': 'application/json', ...input.headers },
      ...(['GET', 'HEAD'].includes(method) ? {} : { body }),
    });
    const response = await handler(request);
    return Response.json({ status: response.status, headers: Object.fromEntries(response.headers),
      body: await response.text(), pulls, cancelled, trace });
  }
  if (path === '/test-only/constructor') return Response.json(trace);
  if (path === '/test-only/recover') return Response.json({ ...await caught(() => store.recover(input.wire)), trace });
  if (path === '/test-only/sequence') {
    const prepared = [], results = [];
    for (const action of input.actions) {
      if (action.kind === 'prepare') results.push(await caught(async () => { prepared.push(await store.prepare(action.wire, action.route)); return prepared.length - 1; }));
      if (action.kind === 'commit') results.push(await caught(() => store.commit(prepared[action.index] ?? {})));
      if (action.kind === 'recover') results.push(await caught(() => store.recover(action.wire)));
    }
    return Response.json({ results, trace });
  }
  if (path === '/test-only/paired' || path === '/test-only/paired-batch') {
    let count = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const db = path.endsWith('paired-batch') ? { withSession(constraint) {
      if (constraint !== 'first-primary') throw new Error('Not primary');
      const session = env.DB.withSession(constraint);
      return { prepare(sql) { return session.prepare(sql); }, async batch(statements) {
        if (++count === 2) release();
        await barrier;
        return session.batch(statements);
      } };
    } } : env.DB;
    const clients = [new D1PollAdmission(db, input.options), new D1PollAdmission(db, input.options)];
    const preparations = [];
    // Complete both durable charges/preparations, then choose which commit wins.
    for (let i = 0; i < 2; i++) preparations.push(await caught(() => clients[i].prepare(input.proofs[i].wire, input.proofs[i].route)));
    if (path.endsWith('paired-batch')) {
      if (preparations.some(p => !p.ok)) return Response.json({ results: preparations, trace });
      return Response.json({ results: await Promise.all(clients.map((c, i) => caught(() => c.commit(preparations[i].value)))), count });
    }
    const results = [];
    for (const i of input.order ?? [0, 1]) results[i] = preparations[i].ok
      ? await caught(() => clients[i].commit(preparations[i].value)) : preparations[i];
    return Response.json({ results, trace });
  }
  if (path === '/test-only/charge-pair') {
    let count = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const db = { withSession(constraint) {
      if (constraint !== 'first-primary') throw new Error('Not primary');
      const session = env.DB.withSession(constraint);
      return { prepare(sql) {
        let statement = session.prepare(sql);
        const wrapper = { bind(...args) { statement = statement.bind(...args); return wrapper; },
          all: () => statement.all(), async first() {
            const result = await statement.first();
            if (sql === META_SQL) { if (++count === 2) release(); await barrier; }
            return result;
          } };
        return wrapper;
      } };
    } };
    const results = await Promise.all([0, 1].map(() => caught(() => new D1PollAdmission(db, input.options).prepare('{'))));
    return Response.json({ results, count });
  }
  if (path !== '/test-only/apply') return new Response(null, { status: 404 });
  const result = await caught(async () => store.commit(await store.prepare(input.wire, input.route)));
  return Response.json({ ...result, trace });
} };
