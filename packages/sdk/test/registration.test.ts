import { it, expect } from 'vitest';
import { createStandaloneServer } from '@openagentforum/server/standalone';
import { SwarmClient } from '../src/client.js';
import { RegistrationError } from '../src/index.js';

it('stops rejected register loops, exposes isolated recovery state, and requires explicit abandonment', async () => {
  const instance = createStandaloneServer({ dbPath: ':memory:', publicOrigin: 'https://relay.test' });
  const methods: string[] = [];
  const fetch = async (url: RequestInfo | URL | string, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET'); return instance.app.request(String(url), init);
  };
  try {
    await SwarmClient.init({ hubUrl: 'https://relay.test', name: 'Already claimed', fetch });
    const client = await SwarmClient.init({ hubUrl: 'https://relay.test', name: 'Already claimed', fetch, autoRegister: false });
    methods.length = 0;
    const error = await client.register().catch(e => e);
    expect(error).toBeInstanceOf(RegistrationError);
    expect(error).toMatchObject({ status: 409, code: 'display_name_claimed', recovery: 'reconcile' });
    const proof = client.getPendingRegistration()!;
    const changed = client.getPendingRegistration()!;
    changed.profile.name = 'Changed copy';
    expect(client.getPendingRegistration()).toEqual(proof);
    for (let i = 0; i < 3; i++) await expect(client.register()).rejects.toBe(error);
    expect(methods).toEqual(['GET', 'POST']);
    expect(await client.registrationState()).toEqual({ revision: 0, agent: null });
    await expect(client.register()).rejects.toBe(error); // reading did not authorize anything
    expect(methods).toEqual(['GET', 'POST', 'GET']);
    expect(() => client.abandonPendingRegistration(changed)).toThrow('Pending registration changed');
    client.abandonPendingRegistration(proof);
    client.name = 'Explicitly chosen replacement';
    expect(await client.register()).toMatchObject({ name: client.name, profileRevision: 1 });
    expect(client.getPendingRegistration()).toBeUndefined();
  } finally { instance.db.close(); }
});

it('does not mistake a lost, subsequently superseded receipt for a failed write', async () => {
  const instance = createStandaloneServer({ dbPath: ':memory:', publicOrigin: 'https://relay.test' });
  const posted: string[] = [];
  let lose = true;
  const fetch = async (url: RequestInfo | URL | string, init?: RequestInit) => {
    const response = await instance.app.request(String(url), init);
    if (init?.method === 'POST') {
      posted.push(String(init.body));
      if (lose) { lose = false; return Response.json({ error: 'registration_outcome_unknown' }, { status: 503 }); }
    }
    return response;
  };
  try {
    const client = await SwarmClient.init({ hubUrl: 'https://relay.test', name: 'First profile', autoRegister: false, fetch });
    await expect(client.register()).rejects.toMatchObject({ code: 'registration_outcome_unknown', recovery: 'retry-exact' });
    const original = client.getPendingRegistration()!;
    const peer = await SwarmClient.init({ hubUrl: client.hubUrl, keyPair: client.keyPair, autoRegister: false, fetch });
    const update = await peer.prepareProfileRegistration({ ...original.profile, name: 'Second profile' });
    expect(update.expectedRevision).toBe(1);
    await peer.submitProfileRegistration(update);
    await expect(client.register()).rejects.toMatchObject({ code: 'registration_not_applied', recovery: 'reconcile' });
    expect(posted[2]).toBe(posted[0]);
    await expect(client.register()).rejects.toMatchObject({ code: 'registration_not_applied' });
    expect(posted).toHaveLength(3);
    expect(await client.registrationState()).toMatchObject({ revision: 2, agent: { name: 'Second profile' } });
    expect(client.getPendingRegistration()).toEqual(original);
    client.abandonPendingRegistration(original); // explicit decision, never automatic rebasing
    expect(await client.register()).toMatchObject({ name: 'Second profile', profileRevision: 2 });
    expect(posted).toHaveLength(3);
  } finally { instance.db.close(); }
});

it('does not allow abandonment or duplicate register calls while an exact retry is in flight', async () => {
  const instance = createStandaloneServer({ dbPath: ':memory:', publicOrigin: 'https://relay.test' });
  let attempts = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, fetch: async (url, init) => {
    if (init?.method === 'POST') {
      attempts++;
      if (attempts === 1) throw new Error('transport unavailable');
      await hold;
    }
    return instance.app.request(String(url), init);
  } });
  try {
    await expect(client.register()).rejects.toMatchObject({ recovery: 'retry-exact' });
    const proof = client.getPendingRegistration()!;
    const pending = client.register();
    expect(client.register()).toBe(pending);
    expect(() => client.abandonPendingRegistration(proof)).toThrow('in flight');
    release();
    expect(await pending).toMatchObject({ profileRevision: 1 });
    expect(attempts).toBe(2);
    expect(client.getPendingRegistration()).toBeUndefined();
  } finally { release(); instance.db.close(); }
});

it('fails closed on old/wrong-origin relays before sending any profile', async () => {
  for (const state of [null, { proofVersion: 2, hub: 'https://other.test', revision: 0, agent: null }]) {
    const methods: string[] = [];
    const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, fetch: async (_, init) => {
      methods.push(init?.method ?? 'GET');
      return state === null ? new Response('old relay', { status: 404 }) : Response.json(state);
    } });
    await expect(client.register()).rejects.toThrow();
    expect(methods).toEqual(['GET']);
  }
});

it('rejects an absent profile with a nonzero state revision without sending a proof', async () => {
  const methods: string[] = [];
  const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, fetch: async (_, init) => {
    methods.push(init?.method ?? 'GET');
    return Response.json({ proofVersion: 2, hub: 'https://relay.test', revision: 1, agent: null });
  } });
  await expect(client.register()).rejects.toThrow('registration state');
  expect(methods).toEqual(['GET']);
});

it.each(['digest', 'historical', 'appliedAt', 'expiredApplication', 'profileVerified', 'null', 'missingReceipt'])('rejects a mismatched %s acknowledgment and retains the exact pending proof', async field => {
  const instance = createStandaloneServer({ dbPath: ':memory:', publicOrigin: 'https://relay.test' });
  const bodies: string[] = [];
  let corrupt = true;
  const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, fetch: async (input, init) => {
    const response = await instance.app.request(String(input), init);
    if (init?.method !== 'POST') return response;
    bodies.push(String(init.body));
    if (!corrupt) return response;
    corrupt = false;
    let value = await response.json() as any;
    if (field === 'profileVerified') value.agent.profileVerified = false;
    else if (field === 'null') value = null;
    else if (field === 'missingReceipt') delete value.receipt;
    else if (field === 'expiredApplication') value.receipt.appliedAt = JSON.parse(String(init.body)).expiresAt;
    else value.receipt[field] = field === 'digest' ? '0'.repeat(64) : field === 'historical' ? false : -1;
    return Response.json(value);
  } });
  try {
    await expect(client.register()).rejects.toThrow('acknowledgment');
    client.name = 'Not a new authorization';
    expect(await client.register()).toMatchObject({ profileRevision: 1, profileVerified: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  } finally { instance.db.close(); }
});

it('submits and checks an isolated proof snapshot, even if the caller mutates its object', async () => {
  const instance = createStandaloneServer({ dbPath: ':memory:', publicOrigin: 'https://relay.test' });
  const bodies: string[] = [];
  const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, fetch: async (input, init) => {
    if (init?.method === 'POST') bodies.push(String(init.body));
    return instance.app.request(String(input), init);
  } });
  try {
    const proof = await client.prepareProfileRegistration({ name: 'Original', x25519PublicKey: null, capabilities: [], metadata: { purpose: 'Original' }, endpoint: null });
    const saved = structuredClone(proof);
    const pending = client.submitProfileRegistration(proof);
    proof.expectedRevision = 42;
    proof.publicKey = '0'.repeat(64);
    proof.profile.name = 'Changed';
    proof.profile.metadata.purpose = 'Changed';
    expect(await pending).toMatchObject({ name: 'Original', profileRevision: 1, metadata: { purpose: 'Original' } });
    expect(JSON.parse(bodies[0])).toEqual(saved);
    await expect(client.submitProfileRegistration(proof)).rejects.toThrow('Invalid registration proof');
    expect(bodies).toHaveLength(1);
    expect(await client.submitProfileRegistration(saved)).toMatchObject({ profileRevision: 1 });
    expect(bodies[1]).toBe(bodies[0]);
  } finally { instance.db.close(); }
});

it('retries exact bytes after a lost response, preserves profiles across restarts, and explicitly updates with CAS', async () => {
  const instance = createStandaloneServer({ dbPath: ':memory:', publicOrigin: 'https://relay.test' });
  const bodies: string[] = [];
  let lose = true;
  const fetch = async (input: RequestInfo | URL | string, init?: RequestInit) => {
    const url = String(input);
    const response = await instance.app.request(url, init);
    if (init?.method === 'POST') {
      bodies.push(String(init.body));
      if (lose) { lose = false; throw new Error('response lost after commit'); }
    }
    return response;
  };
  try {
    const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, name: 'Profile owner', endpoint: 'https://example.invalid/agent', fetch });
    await expect(client.register()).rejects.toThrow('Registration request failed; retain the exact proof');
    client.name = 'Must not silently change the pending proof';
    const recovered = await client.register();
    expect(bodies[1]).toBe(bodies[0]);
    expect(recovered).toMatchObject({ name: 'Profile owner', profileRevision: 1, endpoint: 'https://example.invalid/agent' });
    const restarted = await SwarmClient.init({ hubUrl: 'https://relay.test', keyPair: client.keyPair, name: 'No implicit overwrite', fetch });
    expect(bodies).toHaveLength(2);
    const prepared = await restarted.prepareProfileRegistration({ name: 'Owner update', x25519PublicKey: null, capabilities: [], metadata: {}, endpoint: null });
    expect(prepared.expectedRevision).toBe(1);
    const updated = await restarted.submitProfileRegistration(prepared);
    expect(updated).toMatchObject({ name: 'Owner update', profileRevision: 2 });
    expect(updated.x25519PublicKey).toBeUndefined();
    expect(updated.endpoint).toBeUndefined();
    await expect(restarted.submitProfileRegistration(JSON.parse(bodies[0]))).rejects.toThrow('HTTP 409');
  } finally { instance.db.close(); }
});
