// LOCAL TEST FIXTURE ONLY. No public routing, production configuration or private keys.
import { D1RoomAdmissionStore, initializeD1RoomAdmission } from '../../src/d1-admission.ts';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/test-only/')) return new Response(null, { status: 404 });
    if (path === '/test-only/clock') {
      const result = await env.DB.batch([
        env.DB.prepare("SELECT unixepoch('subsec') * 1000 AS t"),
        env.DB.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) AS s FROM n'),
        env.DB.prepare("SELECT unixepoch('subsec') * 1000 AS t"),
      ]);
      return Response.json({ first: result[0].results[0].t, last: result[2].results[0].t });
    }
    const input = await request.json(); // Trusted, bounded local fixture material only.
    const options = { hub: input.hub, policy: input.policy, now: () => input.now };
    if (path === '/test-only/init') {
      await initializeD1RoomAdmission(env.DB, options);
      return Response.json({ initialized: true });
    }
    if (path === '/test-only/inspect') {
      const rooms = await env.DB.prepare('SELECT * FROM room_lab_rooms ORDER BY room_id').all();
      const receipts = await env.DB.prepare('SELECT receipt_json FROM room_lab_receipts ORDER BY request_id').all();
      const budgets = await env.DB.prepare('SELECT * FROM room_lab_budgets ORDER BY scope, kind').all();
      const gate = await env.DB.prepare('SELECT * FROM room_lab_d1_gate').all();
      return Response.json({ rooms: rooms.results, receipts: receipts.results, budgets: budgets.results, gate: gate.results });
    }
    if (path === '/test-only/fault') {
      if (input.fault === 'missing-guard') await env.DB.prepare('DROP TRIGGER room_lab_d1_finish').run();
      else await env.DB.prepare("CREATE TRIGGER fault BEFORE INSERT ON room_lab_receipts BEGIN SELECT RAISE(ABORT, 'fixture fault'); END").run();
      return Response.json({ installed: true });
    }
    // Model transport uncertainty/delay AFTER using the real D1 binding. Do not
    // add these fault modes or caller clock selection to a production adapter.
    const db = input.fault ? {
      withSession(constraint) {
        const session = env.DB.withSession(constraint);
        return { prepare: session.prepare.bind(session), getBookmark: session.getBookmark.bind(session),
          async batch(statements) {
            if (input.fault === 'queued-expiry') await new Promise(resolve => setTimeout(resolve, 75));
            const list = input.fault === 'final-expiry' ? [...statements.slice(0, -1),
              session.prepare('UPDATE room_lab_meta SET clock = ?').bind(JSON.parse(input.wire).expiresAt), statements.at(-1)] : statements;
            const result = await session.batch(list);
            if (input.fault === 'lost-response') throw new Error('private fixture marker');
            return result;
          },
        };
      },
    } : env.DB;
    const store = new D1RoomAdmissionStore(db, options);
    if (path === '/test-only/submit') return Response.json(await store.submit(input.wire, input.key));
    if (path === '/test-only/recover') return Response.json(await store.recover(input.wire, input.key));
    return new Response(null, { status: 404 });
  },
};
