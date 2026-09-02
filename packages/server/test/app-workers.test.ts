import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import fs from 'node:fs';
import path from 'node:path';
import { app } from '../src/app.js';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';

/** Minimal D1 shim over node:sqlite (same engine standalone uses) so the Workers entrypoint is tested on the same paging contract (#60). */
function d1(db: any) {
  // D1 accepts undefined/booleans; node:sqlite does not. Coerce like D1 would store them.
  const coerce = (v: any) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const stmt = (sql: string, params: any[] = []) => ({
    bind: (...p: any[]) => stmt(sql, p.map(coerce)),
    all: async () => ({ results: db.prepare(sql).all(...params), success: true }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => ({ success: true, meta: db.prepare(sql).run(...params) }),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

describe('Workers app.ts: explicit ?after= is an ascending cursor (#54/#60)', () => {
  const file = 'test-workers.sqlite';
  let env: any;
  beforeAll(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const db = new DatabaseSync(file);
    for (const m of fs.readdirSync(path.join(__dirname, '..', 'migrations')).sort()) {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', m), 'utf8'));
    }
    // Durable Object stub: per-channel monotonic storedSeq, the only DO behavior this path needs.
    const seqs = new Map<string, number>();
    const SWARM_CHANNEL = {
      getByName: (name: string) => ({
        initChannel: async () => {},
        broadcastMessage: async () => {},
        getNextSequence: async () => { const n = (seqs.get(name) ?? 0) + 1; seqs.set(name, n); return n; },
      }),
    };
    env = { DB: d1(db), SWARM_CHANNEL, RELAY_NAME: 'Test Workers Relay' };
  });
  afterAll(() => { if (fs.existsSync(file)) fs.unlinkSync(file); });

  const req = (p: string, init?: RequestInit) => app.request(p, init, env);

  it('pages ascending from after=0 and never reverses a cursor page', async () => {
    const k = await generateAgentKeyPair();
    const reg = await req('/v1/agents/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pager', publicKey: k.signingPublicKey }) });
    expect(reg.status, await reg.clone().text()).toBe(200);
    for (let n = 0; n < 5; n++) {
      const env2 = await signEnvelope({ channel: 'paging', sender: k.agentId, type: 'intel', sequence: n, payload: { n } }, k.signingPrivateKey);
      const r = await req('/v1/channels/paging/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env2) });
      expect(r.status, await r.clone().text()).toBe(200);
    }
    const p1: any = await (await req('/v1/channels/paging/messages?after=0&limit=2')).json();
    expect(p1.messages.map((m: any) => m.sequence)).toEqual([0, 1]); // the natural ASC pager: next = last storedSeq
    const p2: any = await (await req(`/v1/channels/paging/messages?after=${p1.messages[1].storedSeq}&limit=2`)).json();
    expect(p2.messages.map((m: any) => m.sequence)).toEqual([2, 3]);
    const p3: any = await (await req(`/v1/channels/paging/messages?after=${p2.messages[1].storedSeq}&limit=2`)).json();
    expect(p3.messages.map((m: any) => m.sequence)).toEqual([4]);
    const end: any = await (await req(`/v1/channels/paging/messages?after=${p3.messages[0].storedSeq}&limit=2`)).json();
    expect(end.messages).toEqual([]);
    const newest: any = await (await req('/v1/channels/paging/messages?limit=2')).json();
    expect(newest.messages.map((m: any) => m.sequence)).toEqual([3, 4]); // no cursor: newest page, oldest-first
  });
});
