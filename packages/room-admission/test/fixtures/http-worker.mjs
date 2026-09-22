// LOCAL FIXTURE ONLY. These initialization/inspection/fault routes must never ship.
import { onRequestPrivateRoom } from '../../../../apps/web/functions/_lib/private-room-http.ts';
import { initializeD1RoomAdmission } from '../../src/d1-admission.ts';
import { initializeD1RoomRequestBudget } from '../../src/d1-request-gate.ts';
import { canonicalizeJson } from '@openagentforum/protocol';
import { httpConfig } from './http-config.mjs';
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/test-only/slow-body') {
      // Construct the stalled source inside workerd: the Miniflare RPC bridge
      // otherwise buffers the host request before dispatching the handler.
      const body = new ReadableStream({ pull() { return new Promise(() => {}); } });
      return onRequestPrivateRoom(new Request(`${httpConfig.hub}/v1/rooms/control`, { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-oaf-signing-key': '1'.repeat(64) } }), env.DB, httpConfig);
    }
    if (path === '/test-only/init') {
      await initializeD1RoomAdmission(env.DB, { ...httpConfig, now: Date.now });
      await initializeD1RoomRequestBudget(env.DB, { ...httpConfig, now: Date.now });
      return Response.json({ ok: true });
    }
    if (path === '/test-only/inspect') {
      const result = await env.DB.batch([
        env.DB.prepare('SELECT count(*) AS n FROM room_lab_rooms'), env.DB.prepare('SELECT count(*) AS n FROM room_lab_receipts'),
        env.DB.prepare('SELECT count(*) AS n FROM room_lab_packets'), env.DB.prepare('SELECT state_json FROM room_lab_request_budget'),
      ]);
      return Response.json(result.map(r => r.results[0]));
    }
    if (path === '/test-only/saturate') {
      const row = await env.DB.prepare('SELECT state_json FROM room_lab_request_budget').first();
      const state = JSON.parse(row.state_json);
      state.lanes.ordinary.requests = httpConfig.requests.ordinary.requests;
      state.lanes.read.requests = httpConfig.requests.read.requests;
      await env.DB.prepare('UPDATE room_lab_request_budget SET state_json = ?').bind(canonicalizeJson(state)).run();
      return Response.json({ ok: true });
    }
    return onRequestPrivateRoom(request, env.DB, httpConfig);
  },
};
