// Local parent-owned fixture only; never mounted in Pages or deployed.
import { canonicalizeJson } from '@openagentforum/protocol';
import { D1TaskLeases } from '../../src/d1.ts';
import { SCHEMA_OBJECTS } from '../../src/schema.ts';
import { FIXED_BYTES, GUARD_BYTES } from '../../src/contract.ts';
import { CHARGE_SQL, SNAPSHOT_SQL, FINAL_SQL } from '../../src/sql.ts';
import { createD1TaskLeaseHttpHandler } from '../../../../apps/web/functions/_lib/task-lease-http.ts';

const tables = ['task_lease_authority', 'task_lease_actors', 'task_lease_tasks', 'task_lease_guard'];
const caught = async operation => {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, code: error.code ?? 'fixture_error' }; }
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function binding(db, input, trace) {
  const bound = new WeakMap();
  return { withSession(constraint) {
    if (constraint !== 'first-primary') throw new Error('Fixture expected primary');
    trace.sessions++; let executed = false;
    const session = db.withSession(constraint);
    const execute = () => { if (executed) throw new Error('Session reused'); executed = true; };
    function wrap(statement, sql) {
      const wrapper = { bind(...values) { return wrap(statement.bind(...values), sql); }, async all() {
        execute();
        const charge = sql === CHARGE_SQL;
        if (charge) trace.charges++; else trace.reads++;
        if (charge && input.fault === 'charge-before') throw new Error('Fixture unavailable charge');
        const result = await statement.all();
        if (charge && input.fault === 'charge-after') throw new Error('Fixture lost charge reply');
        if (charge && input.fault === 'charge-late' || sql === SNAPSHOT_SQL && input.fault === 'read-late') {
          await wait(input.delayMs ?? input.options.policy.preparationMs + 20);
        }
        return result;
      } };
      bound.set(wrapper, { statement, sql }); return wrapper;
    }
    return { prepare(sql) { return wrap(session.prepare(sql), sql); }, async batch(statements) {
      execute(); trace.batches++;
      const entries = statements.map(s => bound.get(s));
      if (entries.some(s => !s) || entries.at(-1).sql !== FINAL_SQL) throw new Error('Fixture requires final guard');
      let native = entries.map(s => s.statement);
      if (input.beforeBatch) await db.prepare(input.beforeBatch.sql).bind(...(input.beforeBatch.values ?? [])).run();
      if (input.failAfter !== undefined) native.splice(input.failAfter + 1, 0, session.prepare("SELECT json('fixture failure')"));
      if (input.skipStatement !== undefined) native[input.skipStatement] = session.prepare('SELECT 1');
      if (input.beforeFinal) native.splice(-1, 0, session.prepare(input.beforeFinal.sql).bind(...(input.beforeFinal.values ?? [])));
      if (input.fault === 'batch-late-before') await wait(input.delayMs ?? input.options.policy.preparationMs + 20);
      let results;
      try { results = await session.batch(native); } catch (error) { trace.failedBatch = true; throw error; }
      if (input.beforeFinal) results.splice(-2, 1);
      trace.committed = results.at(-1).results.length === 1;
      if (input.fault === 'batch-after') throw new Error('Fixture lost batch reply');
      if (input.fault === 'batch-late-after') await wait(input.delayMs ?? input.options.policy.preparationMs + 20);
      return results;
    } };
  } };
}

export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/test-only/')) return new Response(null, { status: 404 });
  const input = await request.json();
  if (path === '/test-only/init') {
    const c = input.options, statements = SCHEMA_OBJECTS.map(o => env.DB.prepare(o.sql));
    for (const key of input.keys) statements.push(env.DB.prepare('INSERT INTO task_lease_actors VALUES (?, 1, 0, 0, 0)').bind(key));
    statements.push(env.DB.prepare('INSERT INTO task_lease_authority VALUES (1, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?)').bind(
      c.origin, c.audience, c.generation, c.policyRevision, canonicalizeJson(c.policy), input.now,
      Math.floor(input.now / c.policy.windowMs), canonicalizeJson({ completion: 0, ordinary: 0, recovery: 0 }), input.keys.length,
      (2 + input.keys.length) * FIXED_BYTES + GUARD_BYTES));
    await env.DB.batch(statements); return Response.json({ initialized: true });
  }
  if (path === '/test-only/inspect') {
    const state = {};
    for (const name of tables) state[name] = (await env.DB.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()).results;
    return Response.json(state);
  }
  if (path === '/test-only/sql') {
    return Response.json(await caught(async () => (await env.DB.prepare(input.sql).bind(...(input.values ?? [])).all()).results));
  }
  if (path === '/test-only/age') {
    const row = await env.DB.prepare('SELECT * FROM task_lease_tasks WHERE task_id = ?').bind(input.id).first();
    const s = JSON.parse(row.state_json), r = JSON.parse(row.create_receipt), ms = input.ms;
    s.updatedAt -= ms; r.committedAt -= ms;
    if (s.lease) { s.lease.claimedAt -= ms; s.lease.expiresAt -= ms; }
    for (const receipt of s.receipts) { receipt.committedAt -= ms; if (receipt.leaseExpiresAt !== null) receipt.leaseExpiresAt -= ms; }
    await env.DB.batch([env.DB.prepare('DROP TRIGGER task_lease_task_identity'), env.DB.prepare('DROP TRIGGER task_lease_state_guard'),
      env.DB.prepare('UPDATE task_lease_tasks SET state_json = ?, create_receipt = ? WHERE task_id = ?')
        .bind(canonicalizeJson(s), canonicalizeJson(r), input.id),
      ...['task_lease_task_identity', 'task_lease_state_guard'].map(name => env.DB.prepare(SCHEMA_OBJECTS.find(o => o.name === name).sql))]);
    return Response.json({ aged: true });
  }
  const trace = { sessions: 0, reads: 0, charges: 0, batches: 0, pulls: 0 };
  const store = () => new D1TaskLeases(binding(env.DB, input, trace), input.options);
  if (path === '/test-only/http') {
    const handle = createD1TaskLeaseHttpHandler(binding(env.DB, input, trace),
      { ...input.options, bodyTimeoutMs: input.bodyTimeoutMs ?? 1000 });
    const replies = [];
    for (const operation of input.requests) {
      let consumed = false;
      const body = ['GET', 'HEAD'].includes(operation.method) ? undefined : new ReadableStream({ async pull(controller) {
        if (consumed) { controller.close(); return; }
        consumed = true; trace.pulls++;
        // Read the persisted row at the first actual inner-body pull, rather
        // than merely observing that a charge query was dispatched.
        trace.atPull = JSON.parse((await env.DB.prepare('SELECT attempts_json FROM task_lease_authority').first()).attempts_json);
        if (operation.stall) return;
        controller.enqueue(operation.bytes ? new Uint8Array(operation.bytes) : new TextEncoder().encode(operation.body ?? ''));
        controller.close();
      } }, { highWaterMark: 0 });
      const response = await handle(new Request(operation.url, { method: operation.method, headers: operation.headers, body }));
      replies.push({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    return Response.json({ replies, trace });
  }
  if (path === '/test-only/read') return Response.json({ ...await caught(() => store().readTask(input.id)), trace });
  if (path === '/test-only/recover') return Response.json({ ...await caught(() => store().recover(input.wire)), trace });
  if (path === '/test-only/sequence') {
    const s = store(), tokens = [], results = [];
    for (const a of input.actions) {
      results.push(await caught(async () => {
        if (a.kind === 'prepare') { tokens.push(await s.prepare(a.wire, a.lane)); return tokens.length - 1; }
        if (a.kind === 'commit') return s.commit(tokens[a.index] ?? {});
        if (a.kind === 'recover') return s.recover(a.wire);
        if (a.kind === 'read') return s.readTask(a.id);
      }));
    }
    return Response.json({ results, trace });
  }
  if (path === '/test-only/paired') {
    let count = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const db = { withSession(constraint) {
      const session = env.DB.withSession(constraint);
      return { prepare(sql) { return session.prepare(sql); }, async batch(statements) {
        if (++count === 2) release(); await barrier; return session.batch(statements);
      } };
    } };
    const clients = [new D1TaskLeases(db, input.options), new D1TaskLeases(db, input.options)], tokens = [];
    for (let i = 0; i < 2; i++) tokens.push(await clients[i].prepare(input.wires[i], input.lanes[i]));
    return Response.json({ results: await Promise.all(clients.map((s, i) => caught(() => s.commit(tokens[i])))), count });
  }
  if (path === '/test-only/apply') {
    const s = store(), wire = input.deferred ? { async read() { trace.pulls++; return input.wire; } } : input.wire;
    return Response.json({ ...await caught(async () => s.commit(await s.prepare(wire, input.lane))), trace });
  }
  return new Response(null, { status: 404 });
} };
