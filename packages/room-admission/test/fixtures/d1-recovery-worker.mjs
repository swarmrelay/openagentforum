// Local test harness ONLY. Never deploy, mount in Pages, or accept public traffic.
// Fixture seeding is not a D1 admission implementation or production migration.
import { D1RoomReceiptReader } from '../../src/d1-recovery.ts';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !path.startsWith('/test-only/')) return new Response(null, { status: 404 });
    const input = await request.json(); // Bounded, trusted local fixture input; no public route.
    if (path === '/test-only/seed') {
      for (const sql of input.schema.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
      await env.DB.prepare('INSERT INTO room_lab_meta VALUES (1, ?, ?, ?, ?, ?)').bind(...input.meta).run();
      for (const row of input.receipts) await env.DB.prepare('INSERT INTO room_lab_receipts VALUES (?, ?, ?, ?, ?)').bind(...row).run();
      // Rooms/budgets are sentinels: recovery must never read or change these tables.
      await env.DB.prepare("INSERT INTO room_lab_budgets VALUES ('hub', 'create', 0, 1)").run();
      return Response.json({ seeded: true });
    }
    if (path === '/test-only/read') {
      const before = await env.DB.prepare('SELECT clock, policy FROM room_lab_meta').first();
      const rowsBefore = await env.DB.prepare('SELECT * FROM room_lab_receipts ORDER BY request_id').all();
      const reader = new D1RoomReceiptReader(env.DB, { hub: input.hub, policy: input.policy, now: () => input.now });
      const results = await Promise.all(input.queries.map(q => reader.recover(q.wire, q.key)));
      const after = await env.DB.prepare('SELECT clock, policy FROM room_lab_meta').first();
      const rowsAfter = await env.DB.prepare('SELECT * FROM room_lab_receipts ORDER BY request_id').all();
      const budget = await env.DB.prepare('SELECT count(*) AS n FROM room_lab_budgets WHERE count = 1').first();
      return Response.json({ results, unchanged: JSON.stringify(before) === JSON.stringify(after)
        && JSON.stringify(rowsBefore.results) === JSON.stringify(rowsAfter.results), budget: budget.n });
    }
    if (path === '/test-only/storage-failure') {
      const reader = new D1RoomReceiptReader(env.DB, { hub: input.hub, policy: input.policy, now: () => input.now });
      // Deliberately fault only the disposable fixture, never a production database.
      await env.DB.prepare('DROP TABLE room_lab_receipts').run();
      return Response.json([await reader.recover(input.wire, input.key), await reader.recover(input.wire, input.key)]);
    }
    return new Response(null, { status: 404 });
  },
};
