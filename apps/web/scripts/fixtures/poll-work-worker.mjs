// LOCAL TEST FIXTURE ONLY. SQL driver and diagnostics must never be deployed.
import { onRequest } from '../../functions/v1/[[route]].ts';
import { app } from '../../../../packages/server/src/app.ts';

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/fixture/sql') {
      const statements = await request.json();
      return Response.json(await env.DB.batch(statements.map(({ sql, args = [] }) => env.DB.prepare(sql).bind(...args))));
    }
    let sessions = 0, rowsRead = 0, lastPayloads = 0, retainedBytes = 0;
    const DB = {
      prepare: sql => env.DB.prepare(sql),
      batch: statements => env.DB.batch(statements),
      withSession(mode) {
        if (mode !== 'first-primary') throw new Error('Primary session required');
        sessions++;
        const session = env.DB.withSession(mode);
        return { prepare: sql => ({ bind: (...args) => ({ async all() {
          const result = await session.prepare(sql).bind(...args).all();
          rowsRead += result.meta.rows_read;
          lastPayloads = result.results.filter(row => row.payload_json != null).length;
          if (lastPayloads) retainedBytes += result.results[0].total_bytes;
          return result;
        } }) }) };
      },
    };
    let broadcasts = 0;
    const workerAdapter = request.headers.get('x-fixture-adapter') === 'Worker';
    // Native D1 is real; the Worker's DO sequence/broadcast dependency is a
    // local fixture stub, without sockets or claims about production DO parity.
    const SWARM_CHANNEL = { getByName: name => ({
      async getNextSequence() {
        const row = await env.DB.prepare('SELECT COALESCE(MAX(stored_seq), 0) + 1 AS seq FROM messages WHERE channel = ?').bind(name).first();
        return row.seq;
      },
      async broadcastMessage() { broadcasts++; },
    }) };
    const bindings = { DB, PUBLIC_ORIGIN: 'https://relay.test', WAKE_HOOKS_ENABLED: 'false', ...(workerAdapter ? { SWARM_CHANNEL } : {}) };
    const result = workerAdapter
      ? await app.fetch(request, bindings)
      : await onRequest({ request, env: bindings, waitUntil() { throw new Error('Unexpected background work'); } });
    const response = new Response(result.body, result);
    response.headers.set('x-fixture-primary-sessions', String(sessions));
    response.headers.set('x-fixture-rows-read', String(rowsRead));
    response.headers.set('x-fixture-last-payloads', String(lastPayloads));
    response.headers.set('x-fixture-retained-bytes', String(retainedBytes));
    response.headers.set('x-fixture-broadcasts', String(broadcasts));
    return response;
  },
};
