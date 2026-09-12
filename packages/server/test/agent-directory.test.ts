import { afterEach, describe, expect, it } from 'vitest';
import { generateAgentKeyPair, signEnvelope, verifyEnvelope } from '@openagentforum/protocol';
import { adapterFixture } from './adapter-fixture.js';
import { pagesWakeFixture } from './pages-wake-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
type Adapter = 'Worker' | 'standalone' | 'Pages D1' | 'Pages memory';
async function setup(adapter: Adapter) {
  if (adapter === 'Worker' || adapter === 'standalone') {
    const f = adapterFixture(adapter); cleanups.push(f.close); return f;
  }
  const f = await pagesWakeFixture(); cleanups.push(f.close);
  return { db: f.db, request: (path: string, body?: unknown) => f.dispatch(new Request('https://relay.test' + path,
    body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  adapter === 'Pages D1' ? { DB: f.env.DB } : {}) };
}

describe.each(['Worker', 'standalone', 'Pages D1', 'Pages memory'] as const)('%s agent directory (#158)', adapter => {
  it('enumerates beyond the old cap, keeps cursor order stable across activity, and resolves historical authors directly', async () => {
    const f = await setup(adapter);
    const keys = await Promise.all(Array.from({ length: 105 }, () => generateAgentKeyPair()));
    keys.sort((a, b) => a.agentId < b.agentId ? -1 : 1);
    for (const key of keys) {
      expect((await f.request('/v1/agents/register', { publicKey: key.signingPublicKey })).status).toBe(200);
    }
    const author = keys[keys.length - 1];
    const envelope = await signEnvelope({ channel: 'general', sender: author.agentId, type: 'intel', sequence: 19,
      payload: { message: 'local historical verification fixture' } }, author.signingPrivateKey);
    expect((await f.request('/v1/channels/general/messages', envelope)).status).toBe(200);
    // Activity is not a key-retention policy. Make the author inactive on durable adapters.
    if (adapter !== 'Pages memory') f.db.prepare('UPDATE agents SET last_seen_at = 0 WHERE agent_id = ?').run(author.agentId);

    const first = await (await f.request('/v1/agents')).json();
    expect(first.agents).toHaveLength(50);
    expect(first).toMatchObject({ order: 'agent_id_asc', hasMore: true, limit: 50 });
    expect(first.agents.some((a: { agentId: string }) => a.agentId === author.agentId)).toBe(false);
    const { agent } = await (await f.request(`/v1/agents/${author.agentId}`)).json();
    expect(agent.publicKey).toBe(author.signingPublicKey);
    const { messages } = await (await f.request('/v1/channels/general/messages')).json();
    expect((await verifyEnvelope(messages.find((m: { id: string }) => m.id === envelope.id), agent.publicKey)).valid).toBe(true);

    // A heartbeat must not move an already-enumerated key behind the cursor.
    expect((await f.request('/v1/agents/register', { publicKey: keys[0].signingPublicKey })).status).toBe(200);
    const ids: string[] = first.agents.map((a: { agentId: string }) => a.agentId);
    let cursor = first.nextCursor;
    for (let n = 0; cursor !== null && n < 20; n++) {
      const r = await f.request(`/v1/agents?limit=17&cursor=${cursor}`);
      expect(r.status).toBe(200);
      const page = await r.json();
      expect(page.agents.length).toBeLessThanOrEqual(17);
      expect(page.agents.every((a: { agentId: string }) => a.agentId > cursor)).toBe(true);
      ids.push(...page.agents.map((a: { agentId: string }) => a.agentId));
      if (page.hasMore) expect(page.nextCursor).toBe(page.agents.at(-1).agentId);
      else expect(page.nextCursor).toBeNull();
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(ids).toEqual([...new Set(ids)].sort());
    expect(keys.every(key => ids.includes(key.agentId))).toBe(true);
    const maximum = await (await f.request('/v1/agents?limit=100')).json();
    expect(maximum.agents).toHaveLength(100);
    expect(maximum.hasMore).toBe(true);
    const end = await (await f.request('/v1/agents?cursor=agent_ffffffffffffffff')).json();
    expect(end).toMatchObject({ agents: [], hasMore: false, nextCursor: null });
  });

  it('rejects malformed limits/cursors instead of silently truncating or removing the bound', async () => {
    const f = await setup(adapter);
    for (const limit of ['', '0', '-1', '101', '1.5', '1e2', '2junk', 'NaN', 'Infinity', '9007199254740992']) {
      expect((await f.request('/v1/agents?limit=' + encodeURIComponent(limit))).status).toBe(400);
    }
    for (const cursor of ['', 'bad', 'agent_ABCDEF0123456789', 'agent_123', "' OR 1=1 --"]) {
      expect((await f.request('/v1/agents?cursor=' + encodeURIComponent(cursor))).status).toBe(400);
    }
    const one = await (await f.request('/v1/agents?limit=1')).json();
    expect(one.agents.length).toBeLessThanOrEqual(1);
  });
});
