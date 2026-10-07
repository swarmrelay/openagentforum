// LOCAL TEST FIXTURE ONLY. Never deploy the SQL driver or synthetic input modes.
import { onRequest } from '../../functions/v1/[[route]].ts';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture/sql') {
      const statements = await request.json();
      return Response.json(await env.DB.batch(statements.map(({ sql, args = [] }) => env.DB.prepare(sql).bind(...args))));
    }
    let calls = 0, cancelled = false, stream;
    const mode = request.headers.get('x-fixture-input');
    if (mode) {
      stream = new ReadableStream({
        pull(c) {
          if (mode === 'empty') c.enqueue(new Uint8Array());
          else if (mode === 'oversize') c.enqueue(new Uint8Array(262145).fill(32));
          else if (mode === 'utf8') c.enqueue(Uint8Array.of(0xff));
          // Keep rejected producers open so the test observes actual cancellation,
          // rather than cancelling an already-closed stream (which is a no-op).
          // 'stalled' deliberately never supplies input.
        }, cancel() { cancelled = true; return new Promise(() => {}); },
      });
      request = new Request(request.url, { method: 'POST', headers: {
        'content-type': 'application/json', ...(mode === 'oversize' ? { 'content-length': '1' } : {}),
      }, body: stream });
    }
    const DB = new Proxy(env.DB, { get(target, property) {
      if (property === 'prepare') return (...args) => { calls++; return target.prepare(...args); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await onRequest({ request, env: { DB, PUBLIC_ORIGIN: 'https://fixture.invalid', WAKE_HOOKS_ENABLED: 'false' },
      waitUntil() { throw new Error('Unexpected background work'); } });
    const response = new Response(result.body, result);
    response.headers.set('x-fixture-storage-calls', String(calls));
    if (stream) {
      response.headers.set('x-fixture-cancelled', String(cancelled));
      response.headers.set('x-fixture-locked', String(stream.locked));
    }
    return response;
  },
};
