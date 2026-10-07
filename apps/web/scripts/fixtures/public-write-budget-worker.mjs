// LOCAL FIXTURE ONLY: SQL/setup/failure controls must never be deployed.
import { onRequest } from '../../functions/v1/[[route]].ts';
import { createD1PublicWriteAdmission, PUBLIC_WRITE_BUDGET_SCHEMA, publicWriteBudgetSeed,
  PublicWriteBudgetError } from '@openagentforum/server/public-write-budget';

let config, gate;
const operation = path => path === '/v1/agents/register' ? 'registration'
  : path === '/v1/channels' ? 'channel'
  : /^\/v1\/channels\/[^/]+\/messages$/.test(path) ? 'message'
  : path === '/v1/tasks' ? 'task-create'
  : /^\/v1\/tasks\/[^/]+\/claim$/.test(path) ? 'task-claim'
  : /^\/v1\/tasks\/[^/]+\/submit$/.test(path) ? 'task-submit' : undefined;

export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/fixture/sql') {
    const statements = await request.json();
    return Response.json(await env.DB.batch(statements.map(({ sql, args = [] }) => env.DB.prepare(sql).bind(...args))));
  }
  if (path === '/fixture/configure') {
    const { options, initialize } = await request.json(); config = options;
    if (initialize) {
      const seed = publicWriteBudgetSeed(config);
      await env.DB.batch([env.DB.prepare(PUBLIC_WRITE_BUDGET_SCHEMA),
        env.DB.prepare('INSERT INTO public_write_request_budget VALUES (1, 1, ?, ?, ?, ?)')
          .bind(seed.origin, seed.generation, seed.policy, seed.state)]);
    }
    gate = createD1PublicWriteAdmission(env.DB, config);
    return Response.json({ ok: true });
  }
  let protectedCalls = 0, budgetBatches = 0, pulls = 0, cancelled = false;
  const DB = new Proxy(env.DB, { get(target, property) {
    if (property === 'prepare') return (...args) => { protectedCalls++; return target.prepare(...args); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const mode = request.headers.get('x-fixture-failure');
  const controller = mode?.startsWith('abort-') ? new AbortController() : undefined;
  let abortIssued = false;
  if (controller) request = new Request(request, { signal: controller.signal });
  const abortOnce = stage => {
    if (controller && mode === `abort-${stage}` && !abortIssued) { abortIssued = true; controller.abort(); }
  };
  const budgetDB = { withSession(kind) {
    if (kind !== 'first-primary') throw new Error('Replica read not permitted');
    const session = env.DB.withSession(kind);
    return { prepare: sql => {
      const statement = session.prepare(sql);
      return { bind: (...values) => statement.bind(...values), async first() {
        const row = await statement.first(); abortOnce('read'); return row;
      } };
    }, async batch(statements) {
      budgetBatches++; const result = await session.batch(statements);
      if (mode === 'lost') throw new Error('fixture lost commit acknowledgment');
      abortOnce('commit');
      return result;
    } };
  } };
  const fresh = request.headers.has('x-fixture-new-instance') || mode;
  // Retain the cancelled request's exact wrapper for the next native request.
  if (controller) gate = createD1PublicWriteAdmission(budgetDB, config);
  const selected = controller ? gate : fresh ? createD1PublicWriteAdmission(budgetDB, config) : gate;
  if (request.headers.has('x-fixture-stalled-body')) {
    request = new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: new ReadableStream({ pull() { pulls++; }, cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 }) });
  }
  let result;
  const work = () => onRequest({ request, env: { DB, PUBLIC_ORIGIN: config.origin, WAKE_HOOKS_ENABLED: 'false' },
    waitUntil() { throw new Error('Unexpected background work'); } });
  try {
    const op = operation(path);
    result = request.method === 'POST' && op ? await selected.run(request, op, work) : await work();
  } catch (error) {
    if (!(error instanceof PublicWriteBudgetError)) throw error;
    result = error.getResponse();
  }
  const response = new Response(result.body, result);
  response.headers.set('x-fixture-protected-calls', String(protectedCalls));
  response.headers.set('x-fixture-budget-batches', String(budgetBatches));
  response.headers.set('x-fixture-body-pulls', String(pulls));
  response.headers.set('x-fixture-body-cancelled', String(cancelled));
  return response;
} };
