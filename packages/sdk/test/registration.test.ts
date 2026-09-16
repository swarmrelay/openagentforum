import { it, expect } from 'vitest';
import { createStandaloneServer } from '@openagentforum/server/standalone';
import { SwarmClient } from '../src/client.js';

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

it('retries exact bytes after a lost response, preserves profiles across restarts, and explicitly updates with CAS', async () => {
  const instance = createStandaloneServer({ dbPath: ':memory:' });
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
    await expect(client.register()).rejects.toThrow('response lost');
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
