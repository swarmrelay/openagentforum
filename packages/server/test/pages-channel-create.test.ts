import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';
import { onRequest } from '../../../apps/web/functions/v1/[[route]].js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

function fixture(backend: 'D1' | 'memory') {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../../../apps/web/migrations/', import.meta.url);
  for (const name of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  let failWrite = false;
  const statement = (sql: string, args: SQLInputValue[] = []): D1PreparedStatement => ({
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async () => {
      if (failWrite && /INSERT INTO channels/.test(sql)) throw new Error('fixture storage failure');
      return db.prepare(sql).get(...args) ?? null;
    },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  } as D1PreparedStatement);
  const env = { PUBLIC_ORIGIN: 'https://fixture.invalid',
    ...(backend === 'D1' ? { DB: { prepare: (sql: string) => statement(sql) } as D1Database } : {}) };
  const send = (path: string, body?: unknown) => Promise.resolve(onRequest({
    request: new Request(`https://fixture.invalid${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), env, waitUntil: () => {},
  } as Parameters<typeof onRequest>[0]));
  const name = `create-${crypto.randomUUID()}`;
  const read = async () => (await (await send(`/v1/channels/${name}`)).json() as { channel: unknown }).channel;
  return { db, name, send, read, failWrites: () => { failWrite = true; } };
}

describe.each(['D1', 'memory'] as const)('Pages create-only channels (%s)', backend => {
  it('rejects replacements, including a claimed creator, without changing any stored fields or messages', async () => {
    const f = fixture(backend);
    try {
      const keys = await generateAgentKeyPair();
      expect((await f.send('/v1/agents/register', { publicKey: keys.signingPublicKey })).status).toBe(200);
      const body = { name: f.name, title: 'Original title', topic: 'Original topic', creatorId: keys.agentId };
      expect((await f.send('/v1/channels', body)).status).toBe(200);
      const envelope = await signEnvelope({ channel: f.name, sender: keys.agentId, type: 'intel', sequence: 1,
        payload: { message: 'Preserve this history' } }, keys.signingPrivateKey);
      expect((await f.send(`/v1/channels/${f.name}/messages`, envelope)).status).toBe(200);
      const before = await f.read();
      const messagesBefore = await (await f.send(`/v1/channels/${f.name}/messages`)).json();
      for (const request of [body, { ...body, title: 'Replacement', topic: 'Changed' },
        { ...body, creatorId: 'system' }, { ...body, isPrivate: true }, { ...body, e2eeRequired: true }]) {
        const response = await f.send('/v1/channels', request);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ reason: 'channel_exists' });
        expect(await f.read()).toEqual(before);
        expect(await (await f.send(`/v1/channels/${f.name}/messages`)).json()).toEqual(messagesBefore);
      }
    } finally { f.db.close(); }
  });

  it('allows exactly one concurrent creation and returns the stored winner', async () => {
    const f = fixture(backend);
    try {
      const responses = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        f.send('/v1/channels', { name: f.name, title: `Contender ${i}`, topic: `Topic ${i}`, creatorId: `claim-${i}` })));
      expect(responses.filter(r => r.status === 200)).toHaveLength(1);
      expect(responses.filter(r => r.status === 409)).toHaveLength(7);
      const winner = await responses.find(r => r.status === 200)!.json() as { channel: unknown };
      expect(await f.read()).toEqual(winner.channel);
    } finally { f.db.close(); }
  });

  it('preserves protected channel flags on duplicate creates', async () => {
    const f = fixture(backend);
    try {
      expect((await f.send('/v1/channels', { name: f.name, title: 'Encrypted', isPrivate: true, e2eeRequired: true })).status).toBe(200);
      const before = await f.read();
      expect((await f.send('/v1/channels', { name: f.name, title: 'Public replacement' })).status).toBe(409);
      expect(await f.read()).toEqual(before);
    } finally { f.db.close(); }
  });
});

it('does not turn a D1 write failure into a successful memory channel', async () => {
  const f = fixture('D1');
  try {
    f.failWrites();
    expect((await f.send('/v1/channels', { name: f.name, title: 'Not committed' })).status).toBe(500);
    expect((await f.send(`/v1/channels/${f.name}`)).status).toBe(404);
    const response = await onRequest({ request: new Request(`https://fixture.invalid/v1/channels/${f.name}`),
      env: {}, waitUntil: () => {} } as Parameters<typeof onRequest>[0]);
    expect(response.status).toBe(404);
  } finally { f.db.close(); }
});
