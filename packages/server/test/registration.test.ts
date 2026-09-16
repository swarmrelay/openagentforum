import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAgentKeyPair, signRegistrationProof, signEnvelope, verifyEnvelope } from '@openagentforum/protocol';
import { onRequest } from '../../../apps/web/functions/v1/[[route]].js';
import { adapterFixture } from './adapter-fixture.js';
import { profileProof } from './registration-fixture.js';
import { handleRegistration, sqlRegistrationStore } from '../src/registration.js';
import { createStandaloneServer } from '../src/standalone.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
function fixture(adapter: string) {
  if (adapter === 'Worker' || adapter === 'standalone') return adapterFixture(adapter);
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../../../apps/web/migrations/', import.meta.url);
  for (const name of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  const statement = (sql: string, args: any[] = []): any => ({
    bind: (...values: any[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  const env = adapter === 'Pages D1' ? { DB: { prepare: (sql: string) => statement(sql) } } : {};
  const request = (path: string, body?: unknown) => Promise.resolve(onRequest({
    request: new Request('https://relay.test' + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    env, waitUntil() { throw new Error('No detached registration work'); },
  } as any));
  return { db, request, close: () => db.close() };
}

describe.each(['Worker', 'standalone', 'Pages D1', 'Pages memory'])('v2 profile admission: %s', adapter => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) close(); });
  const setup = () => { const f = fixture(adapter); cleanups.push(f.close); return f; };

  it('unsigned announcements cannot preclaim a name, inject encryption keys or bump activity', async () => {
    const f = setup(), keys = await generateAgentKeyPair(), other = await generateAgentKeyPair();
    const announced: any = await (await f.request('/v1/agents/register', { publicKey: keys.signingPublicKey,
      name: `Target-${other.agentId.slice(6)}`, x25519PublicKey: other.encryptionPublicKey,
      capabilities: ['forged'], metadata: { forged: true }, endpoint: 'https://example.invalid/' })).json();
    expect(announced.profileApplied).toBe(false);
    expect(announced.agent).toMatchObject({ profileRevision: 0, profileVerified: false, capabilities: [], metadata: {} });
    expect(announced.agent.x25519PublicKey).toBeUndefined();
    expect(announced.agent.endpoint).toBeUndefined();
    const claim = await profileProof(other, `Target-${other.agentId.slice(6)}`);
    expect((await f.request('/v1/agents/register', claim)).status).toBe(200);
    const replay: any = await (await f.request('/v1/agents/register', { publicKey: keys.signingPublicKey })).json();
    expect(replay.agent).toEqual(announced.agent);
    // The immutable verification key remains usable by forwarded signed messages.
    const envelope = await signEnvelope({ channel: 'general', sender: keys.agentId, sequence: 1, type: 'intel', payload: { message: 'fixture' } }, keys.signingPrivateKey);
    expect((await verifyEnvelope(envelope, announced.agent.publicKey)).valid).toBe(true);
    const promoted: any = await (await f.request('/v1/agents/register', await profileProof(keys))).json();
    expect(promoted.agent.profileRevision).toBe(1);
    expect(promoted.agent.x25519PublicKey).toBe(keys.encryptionPublicKey);
    expect(promoted.agent.registeredAt).toBe(announced.agent.registeredAt);
    expect((await verifyEnvelope(envelope, promoted.agent.publicKey)).valid).toBe(true);
  });

  it('rejects legacy proofs on first creation and updates, as well as malformed keys/bodies', async () => {
    const f = setup(), keys = await generateAgentKeyPair();
    const timestamp = Date.now();
    const legacy = { publicKey: keys.signingPublicKey, name: 'Forged', timestamp,
      proofSignature: await signRegistrationProof(keys.agentId, timestamp, keys.signingPrivateKey) };
    expect((await f.request('/v1/agents/register', legacy)).status).toBe(403);
    expect((await f.request('/v1/agents/' + keys.agentId)).status).toBe(404);
    const signed = await profileProof(keys);
    expect((await f.request('/v1/agents/register', signed)).status).toBe(200);
    expect((await f.request('/v1/agents/register', legacy)).status).toBe(403);
    for (const publicKey of ['abc', 'zz'.repeat(32), 7, {}, null, '00'.repeat(33)]) {
      expect((await f.request('/v1/agents/register', { publicKey })).status).toBe(400);
    }
    expect((await f.request('/v1/agents/register', { publicKey: keys.signingPublicKey, padding: 'x'.repeat(17_000) })).status).toBe(413);
    expect((await f.request('/v1/agents/register', null)).status).toBe(400);
  });

  it('binds every profile field, origin, action, public key, clock and revision', async () => {
    const f = setup(), keys = await generateAgentKeyPair(), other = await generateAgentKeyPair();
    const proof = await profileProof(keys);
    const changes = [
      { profile: { ...proof.profile, name: 'Changed' } },
      { profile: { ...proof.profile, x25519PublicKey: other.encryptionPublicKey } },
      { profile: { ...proof.profile, capabilities: ['changed'] } },
      { profile: { ...proof.profile, metadata: { changed: true } } },
      { profile: { ...proof.profile, endpoint: 'https://changed.example/' } },
      { hub: 'https://other.test' }, { action: 'delete' }, { publicKey: other.signingPublicKey },
      { expectedRevision: 1 }, { issuedAt: proof.issuedAt + 1 }, { expiresAt: proof.expiresAt + 1 },
      { unknown: true }, { proofVersion: 1 },
    ];
    for (const changed of changes) expect((await f.request('/v1/agents/register', { ...proof, ...changed })).status).toBe(403);
    const wrongHub = await profileProof(keys, undefined, { hub: 'https://other.test' });
    expect((await f.request('/v1/agents/register', wrongHub)).status).toBe(403);
    expect((await f.request('/v1/agents/' + keys.agentId)).status).toBe(404);
  });

  it('applies one revision atomically, makes identical retries historical, and fences older proofs', async () => {
    const f = setup(), keys = await generateAgentKeyPair();
    const proof = await profileProof(keys);
    const first: any = await (await f.request('/v1/agents/register', proof)).json();
    expect(first.agent.profileRevision).toBe(1);
    const unchanged: any = await (await f.request('/v1/agents/register', proof)).json();
    expect(unchanged.replayed).toBe(true);
    expect(unchanged.agent).toEqual(first.agent);
    expect(unchanged.receipt).toEqual(first.receipt);
    const stateResponse = await f.request(`/v1/agents/${keys.agentId}/registration`);
    expect(stateResponse.headers.get('cache-control')).toBe('no-store');
    expect(await stateResponse.json()).toMatchObject({ proofVersion: 2, hub: 'https://relay.test', revision: 1 });
    const [a, b] = await Promise.all(['A', 'B'].map(suffix => profileProof(keys, proof.profile.name + suffix, { expectedRevision: 1 })));
    const responses = await Promise.all([f.request('/v1/agents/register', a), f.request('/v1/agents/register', b)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const winner: any = await responses.find(r => r.status === 200)!.json();
    expect(winner.agent.profileRevision).toBe(2);
    expect(winner.agent.registeredAt).toBe(first.agent.registeredAt);
    expect((await f.request('/v1/agents/register', proof)).status).toBe(409);
    const clear = await profileProof(keys, undefined, { expectedRevision: 2,
      profile: { ...proof.profile, x25519PublicKey: null, endpoint: null } });
    const cleared: any = await (await f.request('/v1/agents/register', clear)).json();
    expect(cleared.agent.x25519PublicKey).toBeUndefined();
    expect(cleared.agent.profileRevision).toBe(3);
  });

  it('exact concurrent retries commit once, and name uniqueness still wins races', async () => {
    const f = setup(), keys = await generateAgentKeyPair(), other = await generateAgentKeyPair();
    const proof = await profileProof(keys);
    const results: any[] = await Promise.all(Array.from({ length: 4 }, async () => (await f.request('/v1/agents/register', proof)).json()));
    expect(results.map(r => r.agent?.profileRevision)).toEqual([1, 1, 1, 1]);
    expect(results.filter(r => r.replayed === false)).toHaveLength(1);
    expect((await f.request('/v1/agents/register', await profileProof(other, proof.profile.name.toLowerCase()))).status).toBe(409);
  });

  it('rejects expired/future proofs and nonzero first revisions without creating rows', async () => {
    const f = setup(), keys = await generateAgentKeyPair();
    const now = Date.now();
    for (const fields of [{ issuedAt: now - 120_000, expiresAt: now - 60_000 },
      { issuedAt: now + 60_000, expiresAt: now + 120_000 }, { expectedRevision: 2 }]) {
      expect((await f.request('/v1/agents/register', await profileProof(keys, undefined, fields))).status).toBe(409);
    }
    expect((await f.request('/v1/agents/' + keys.agentId)).status).toBe(404);
  });

  it('recovers an exact historical receipt after proof expiry without another mutation', async () => {
    const f = setup(), keys = await generateAgentKeyPair();
    const proof = await profileProof(keys, undefined, { expiresAt: Date.now() + 250 });
    const first: any = await (await f.request('/v1/agents/register', proof)).json();
    expect(first.agent.profileRevision).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 300));
    const retry: any = await (await f.request('/v1/agents/register', proof)).json();
    expect(retry).toEqual({ ...first, replayed: true });
  });
});

describe('atomic SQL boundary and uncertain commits', () => {
  it('retains receipts and key-only name reservations across a standalone restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'oaf-registration-restart-'));
    let instance = createStandaloneServer({ dbPath: join(directory, 'relay.sqlite') });
    const send = (value: unknown) => instance.app.request('https://relay.test/v1/agents/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    try {
      const keys = await generateAgentKeyPair(), keyOnly = await generateAgentKeyPair();
      const proof = await profileProof(keys);
      const first: any = await (await send(proof)).json();
      expect(first.receipt.revision).toBe(1);
      expect((await send({ publicKey: keyOnly.signingPublicKey })).status).toBe(200);
      const before = instance.db.prepare('SELECT * FROM agents ORDER BY agent_id').all();
      instance.db.close();
      instance = createStandaloneServer({ dbPath: join(directory, 'relay.sqlite') });
      expect(instance.db.prepare('SELECT * FROM agents ORDER BY agent_id').all()).toEqual(before);
      expect(await (await send(proof)).json()).toEqual({ ...first, replayed: true });
      // A key announcement did not claim even its generated display name after migration/restart.
      const claimant = await generateAgentKeyPair();
      expect((await send(await profileProof(claimant, `Agent-${keyOnly.agentId.slice(6)}`))).status).toBe(200);
    } finally { instance.db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not acknowledge a thrown commit; exact retry recovers the retained receipt', async () => {
    const f = adapterFixture('standalone');
    try {
      let loseResult = true;
      const store = sqlRegistrationStore(async (sql, args) => {
        const row = f.db.prepare(sql).get(...args) as any ?? null;
        if (sql.includes('ON CONFLICT(agent_id) DO UPDATE') && loseResult) { loseResult = false; throw new Error('private storage failure'); }
        return row;
      });
      const keys = await generateAgentKeyPair(), proof = await profileProof(keys);
      const request = () => new Request('https://relay.test/v1/agents/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof) });
      const lost = await handleRegistration(request(), store, 'https://relay.test');
      expect(lost.status).toBe(503);
      expect(await lost.text()).not.toContain('private storage failure');
      const recovered: any = await (await handleRegistration(request(), store, 'https://relay.test')).json();
      expect(recovered.replayed).toBe(true);
      expect(recovered.receipt.revision).toBe(1);
    } finally { f.close(); }
  });

  it('rechecks database time after verification, preserves full-key binding and fences clock rollback', async () => {
    const f = adapterFixture('standalone');
    try {
      const keys = await generateAgentKeyPair();
      const proof = await profileProof(keys, undefined, { issuedAt: Date.now() - 1000, expiresAt: Date.now() + 50 });
      const store = sqlRegistrationStore(async (sql, args) => {
        if (sql.includes('ON CONFLICT(agent_id) DO UPDATE')) await new Promise(resolve => setTimeout(resolve, 75));
        return f.db.prepare(sql).get(...args) as any ?? null;
      });
      const send = (value: unknown) => handleRegistration(new Request('https://relay.test/v1/agents/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }), store, 'https://relay.test');
      expect((await send(proof)).status).toBe(409);
      expect(f.db.prepare('SELECT * FROM agents').all()).toHaveLength(0);
      const fresh = await profileProof(keys);
      expect((await send(fresh)).status).toBe(200);
      f.db.prepare('UPDATE agents SET registration_applied_at = ?').run(Date.now() + 100_000);
      expect((await send(await profileProof(keys, undefined, { expectedRevision: 1 }))).status).toBe(409);
      f.db.prepare('UPDATE agents SET public_key = ?').run((await generateAgentKeyPair()).signingPublicKey);
      expect((await send(fresh)).status).toBe(409);
      expect((await send({ publicKey: keys.signingPublicKey })).status).toBe(409);
    } finally { f.close(); }
  });
});
