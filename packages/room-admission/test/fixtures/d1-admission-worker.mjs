// LOCAL TEST FIXTURE ONLY. No public routing, production configuration or private keys.
import { D1RoomAdmissionStore, initializeD1RoomAdmission } from '../../src/d1-admission.ts';
import { createBudgetedD1RoomStore, initializeD1RoomRequestBudget } from '../../src/d1-request-gate.ts';

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
    const options = { hub: input.hub, policy: input.policy, packets: input.packets, now: () => input.now };
    if (path === '/test-only/budget-init') {
      await initializeD1RoomRequestBudget(env.DB, { ...options, requests: input.requests });
      return Response.json({ initialized: true });
    }
    if (path === '/test-only/budget-inspect') {
      return Response.json((await env.DB.prepare('SELECT * FROM room_lab_request_budget').all()).results);
    }
    if (path === '/test-only/budget-remove') {
      await env.DB.prepare('DELETE FROM room_lab_request_budget').run();
      return Response.json({ removed: true });
    }
    if (path.startsWith('/test-only/budget-')) {
      let clock = input.now;
      const primary = { withSession(constraint) {
        if (constraint !== 'first-primary') throw new Error('Not primary');
        const session = env.DB.withSession(constraint);
        let charge = false;
        return { prepare(sql) {
          if (sql.startsWith('UPDATE room_lab_request_budget')) charge = true;
          return session.prepare(sql);
        }, async batch(statements) {
          const results = await session.batch(statements);
          if (charge && input.fault === 'lost-budget-response') throw new Error('Fixture lost acknowledgment');
          if (charge && input.fault === 'late-budget-response') clock += input.requests.windowMs;
          return results;
        } };
      } };
      const store = createBudgetedD1RoomStore(primary, { ...options, requests: input.requests, now: () => clock });
      const method = path.slice('/test-only/budget-'.length);
      if (!['submit', 'recover', 'readState', 'writePacket', 'readPackets', 'recoverPacket'].includes(method)) return new Response(null, { status: 404 });
      return Response.json(await store[method](input.wire, input.key));
    }
    if (path === '/test-only/init') {
      await initializeD1RoomAdmission(env.DB, options);
      return Response.json({ initialized: true });
    }
    if (path === '/test-only/inspect') {
      const rooms = await env.DB.prepare('SELECT * FROM room_lab_rooms ORDER BY room_id').all();
      const receipts = await env.DB.prepare('SELECT receipt_json FROM room_lab_receipts ORDER BY request_id').all();
      const budgets = await env.DB.prepare('SELECT * FROM room_lab_budgets ORDER BY scope, kind').all();
      const gate = await env.DB.prepare('SELECT * FROM room_lab_d1_gate').all();
      const meta = await env.DB.prepare('SELECT * FROM room_lab_meta').all();
      const packets = {};
      if (input.packets) for (const table of ['room_lab_packets', 'room_lab_packet_sessions', 'room_lab_packet_usage', 'room_lab_packet_windows', 'room_lab_d1_packet_gate']) {
        packets[table] = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
      }
      return Response.json({ rooms: rooms.results, receipts: receipts.results, budgets: budgets.results, gate: gate.results, meta: meta.results, ...packets });
    }
    if (path === '/test-only/fault') {
      if (input.fault === 'packet-missing-guard') await env.DB.prepare('DROP TRIGGER room_lab_d1_packet_finish').run();
      else if (input.fault === 'packet-statement') await env.DB.prepare("CREATE TRIGGER fault BEFORE INSERT ON room_lab_packets BEGIN SELECT RAISE(ABORT, 'fixture fault'); END").run();
      else if (input.fault === 'packet-ignore-budget') await env.DB.prepare("CREATE TRIGGER fault BEFORE INSERT ON room_lab_packet_usage BEGIN SELECT RAISE(IGNORE); END").run();
      else if (input.fault === 'missing-guard') await env.DB.prepare('DROP TRIGGER room_lab_d1_finish').run();
      else await env.DB.prepare("CREATE TRIGGER fault BEFORE INSERT ON room_lab_receipts BEGIN SELECT RAISE(ABORT, 'fixture fault'); END").run();
      return Response.json({ installed: true });
    }
    if (path === '/test-only/packet-read' || path === '/test-only/packet-recover') {
      let clock = input.now;
      const readOnly = { withSession(constraint) {
        if (constraint !== 'first-primary') throw new Error('Not primary');
        const session = env.DB.withSession(constraint); let used = false;
        return { prepare(sql) {
          if (used || !sql.startsWith('SELECT ')) throw new Error('One read per fresh session');
          used = true; let statement = session.prepare(sql);
          const wrapper = { bind(...args) { statement = statement.bind(...args); return wrapper; }, async first() {
            const result = await statement.first();
            if (sql.includes('records_json') || sql.includes('old.receipt_json')) {
              if (input.fault === 'read-expiry') clock = JSON.parse(input.wire).expiresAt;
              if (input.closeWire) {
                const result = await new D1RoomAdmissionStore(env.DB, options).submit(input.closeWire, input.closeKey);
                if (!result.ok) throw new Error('Fixture close failed');
              }
            }
            return result;
          } }; return wrapper;
        }, async batch() { throw new Error('Read only'); } };
      } };
      const store = new D1RoomAdmissionStore(readOnly, { ...options, now: () => clock });
      return Response.json(path.endsWith('packet-read') ? await store.readPackets(input.wire) : await store.recoverPacket(input.wire));
    }
    if (path === '/test-only/state') {
      let clock = input.now, queries = 0;
      const readOnlyDb = {
        withSession(constraint) {
          if (constraint !== 'first-primary') throw new Error('Only primary reads');
          const session = env.DB.withSession(constraint);
          let used = false;
          return {
            prepare(sql) {
              if (used || !sql.startsWith('SELECT ')) throw new Error('One SELECT per session');
              used = true;
              let statement = session.prepare(sql);
              const wrapper = {
                bind(...args) { statement = statement.bind(...args); return wrapper; },
                async first() {
                  queries++;
                  const result = await statement.first();
                  if (sql.includes('LEFT JOIN room_lab_rooms')) {
                    if (input.fault === 'state-expiry') clock = JSON.parse(input.wire).expiresAt;
                    if (input.fault === 'state-failure') throw new Error('private read fixture marker');
                    // A separate, real signed mutation committed AFTER this read snapshot.
                    if (input.closeWire) {
                      const closer = new D1RoomAdmissionStore(env.DB, options);
                      const closed = await closer.submit(input.closeWire, input.key);
                      if (!closed.ok) throw new Error('Fixture close failed');
                    }
                  }
                  return result;
                },
              };
              return wrapper;
            },
            async batch() { throw new Error('Read only'); }, getBookmark() { return null; },
          };
        },
      };
      const reader = new D1RoomAdmissionStore(readOnlyDb, { ...options, now: () => clock });
      const result = await reader.readState(input.wire, input.key);
      const poisoned = input.fault === 'state-failure' ? [
        await reader.submit('invalid', input.key), await reader.recover('invalid', input.key),
        await reader.readState('invalid', input.key),
      ] : [];
      return Response.json({ result, queries, poisoned });
    }
    // Model transport uncertainty/delay AFTER using the real D1 binding. Do not
    // add these fault modes or caller clock selection to a production adapter.
    const db = input.fault || input.closeWire ? {
      withSession(constraint) {
        const session = env.DB.withSession(constraint);
        return { prepare: session.prepare.bind(session), getBookmark: session.getBookmark.bind(session),
          async batch(statements) {
            if (input.closeWire) {
              const closed = await new D1RoomAdmissionStore(env.DB, options).submit(input.closeWire, input.closeKey);
              if (!closed.ok) throw new Error('Fixture close failed');
            }
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
    if (path === '/test-only/packet-write') return Response.json(await store.writePacket(input.wire));
    if (path === '/test-only/submit') return Response.json(await store.submit(input.wire, input.key));
    if (path === '/test-only/recover') return Response.json(await store.recover(input.wire, input.key));
    return new Response(null, { status: 404 });
  },
};
