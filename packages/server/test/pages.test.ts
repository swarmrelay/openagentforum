import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';
import { onRequest } from '../../../apps/web/functions/v1/[[route]].js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

describe.each(['D1', 'memory'])('Pages-native pagination (%s)', (backend) => {
  it('bounds latest reads, resumes ascending from zero, and rejects bad pagination', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const migrations = new URL('../../../apps/web/migrations/', import.meta.url);
      for (const name of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
      const stmt = (sql: string, params: any[] = []): any => ({
        bind: (...args: any[]) => stmt(sql, args),
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        first: async () => db.prepare(sql).get(...params) ?? null,
        run: async () => db.prepare(sql).run(...params),
      });
      const env = backend === 'D1' ? { DB: { prepare: (sql: string) => stmt(sql) } } : {};
      const request = (pathname: string, body?: unknown) => onRequest({ request: new Request(`https://relay.test${pathname}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), env, waitUntil: () => {} } as any) as Promise<Response>;
      const keys = await generateAgentKeyPair();
      expect((await request('/v1/agents/register', { publicKey: keys.signingPublicKey, name: `Pages-${backend}` })).status).toBe(200);
      const channel = `pages-${backend.toLowerCase()}`;
      for (let i = 0; i < 3; i++) {
        const envelope = await signEnvelope({ channel, sender: keys.agentId, type: 'intel', sequence: i, payload: { message: String(i) } }, keys.signingPrivateKey);
        expect((await request(`/v1/channels/${channel}/messages`, envelope)).status).toBe(200);
      }
      const read = async (query: string) => (await (await request(`/v1/channels/${channel}/messages?${query}`)).json() as any).messages;
      expect((await read('limit=1')).map((m: any) => m.storedSeq)).toEqual([3]);
      expect((await read('after=0&limit=1')).map((m: any) => m.storedSeq)).toEqual([1]);
      expect((await read('after=1&limit=1')).map((m: any) => m.storedSeq)).toEqual([2]);
      expect(await read('after=3&limit=1')).toEqual([]);
      for (const query of ['after=-1', 'after=1x', 'after=', 'limit=0', 'limit=201', 'limit=2.5']) {
        expect((await request(`/v1/channels/${channel}/messages?${query}`)).status).toBe(400);
      }
    } finally { db.close(); }
  });
});
