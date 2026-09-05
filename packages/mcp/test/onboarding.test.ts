import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwarmMcpServer, type McpServerConfig } from '../src/index.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { createStandaloneServer, type StandaloneInstance } from '@openagentforum/server/standalone';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('MCP agent onboarding and tool calls', () => {
  let instance: StandaloneInstance;
  let directory: string;
  let identityPath: string;
  let requests: Array<{ path: string; method: string }>;
  const peers: Client[] = [];
  const hubUrl = 'http://localhost:8787';
  const customFetch = async (input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ path: new URL(url).pathname, method: init?.method || 'GET' });
    return instance.app.request(url, init);
  };

  beforeEach(() => {
    instance = createStandaloneServer({ dbPath: ':memory:' });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mcp-onboarding-'));
    identityPath = path.join(directory, 'agent', 'identity.json');
    requests = [];
    vi.stubGlobal('fetch', customFetch);
  });

  afterEach(async () => {
    await Promise.all(peers.splice(0).map((peer) => peer.close()));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    instance.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function connect(config: McpServerConfig = {}) {
    const swarm = createSwarmMcpServer({ hubUrl, agentName: 'MCP-Test-Agent', identityPath, ...config });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const peer = new Client({ name: 'test-host', version: '1.0.0' });
    peers.push(peer);
    await swarm.server.connect(serverTransport);
    await peer.connect(clientTransport);
    return { ...swarm, peer };
  }

  it('lists and reads public data without registering or creating identity files', async () => {
    const { peer } = await connect();
    const tools = await peer.listTools();
    expect(tools.tools.find((tool) => tool.name === 'list_channels')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === 'post_intel')?.annotations?.readOnlyHint).toBe(false);
    for (const [name, args] of [
      ['list_channels', {}], ['read_channel', { channel: 'general', after: 0 }],
      ['list_tasks', {}], ['list_polls', {}], ['search_intel', { query: 'hello' }],
    ] as const) {
      const result = await peer.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
    }
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(fs.existsSync(identityPath)).toBe(false);
    expect(instance.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n).toBe(0);
  });

  it('reuses its identity and continues signed sequences after an MCP restart', async () => {
    const first = await connect();
    expect((await first.peer.callTool({ name: 'post_intel', arguments: { channel: 'general', insight: 'first visit' } })).isError).not.toBe(true);
    const original = await first.getClient();
    await first.peer.close();
    const second = await connect();
    expect((await second.peer.callTool({ name: 'post_intel', arguments: { channel: 'general', insight: 'returned' } })).isError).not.toBe(true);
    expect((await second.getClient()).agentId).toBe(original.agentId);
    const messages = await original.getMessages('general', { after: 0 });
    expect(messages.map((message) => message.sequence)).toEqual([0, 1]);
    expect(instance.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n).toBe(1);
    expect(fs.statSync(identityPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(identityPath)).mode & 0o777).toBe(0o700);
  });

  it('reports a registration outage as a tool error and retries using the saved key', async () => {
    let fail = true;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (fail && input.endsWith('/agents/register')) { fail = false; return new Response('temporarily unavailable', { status: 503 }); }
      return customFetch(input, init);
    });
    const { peer, getClient } = await connect();
    const args = { name: 'post_intel', arguments: { channel: 'general', insight: 'retry after outage' } };
    const failed = await peer.callTool(args);
    expect(failed.isError).toBe(true);
    const saved = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    expect(JSON.stringify(failed)).not.toContain(saved.signingPrivateKey);
    expect((await peer.callTool({ name: 'list_channels', arguments: {} })).isError).not.toBe(true);
    expect((await peer.callTool(args)).isError).not.toBe(true);
    expect((await getClient()).agentId).toBe(saved.agentId);
  });

  it('can still browse when its configured name belongs to another identity', async () => {
    await (await connect()).getClient();
    const { peer } = await connect({ identityPath: path.join(directory, 'other', 'identity.json') });
    expect((await peer.callTool({ name: 'post_intel', arguments: { channel: 'general', insight: 'collision' } })).isError).toBe(true);
    expect((await peer.callTool({ name: 'list_channels', arguments: {} })).isError).not.toBe(true);
  });

  it('reads successive pages from storedSeq zero through the MCP tool', async () => {
    const { peer, getClient } = await connect();
    const writer = await getClient();
    for (let i = 0; i < 3; i++) await writer.postIntel('general', { insight: `message ${i}` });
    const read = async (after: number) => {
      const result = await peer.callTool({ name: 'read_channel', arguments: { channel: 'general', after, limit: 1 } });
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    };
    const first = await read(0);
    const second = await read(first[0].storedSeq);
    expect(first[0].payload.insight).toBe('message 0');
    expect(second[0].payload.insight).toBe('message 1');
    expect((await peer.callTool({ name: 'read_channel', arguments: { channel: 'general', after: -1 } })).isError).toBe(true);
  });

  it('does not overwrite a corrupt identity or require it for public reads', async () => {
    fs.mkdirSync(path.dirname(identityPath));
    fs.writeFileSync(identityPath, '{broken identity');
    const { peer } = await connect();
    const result = await peer.callTool({ name: 'post_intel', arguments: { channel: 'general', insight: 'hello' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Invalid identity file');
    expect(fs.readFileSync(identityPath, 'utf8')).toBe('{broken identity');
    expect((await peer.callTool({ name: 'list_channels', arguments: {} })).isError).not.toBe(true);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('honors SWARM_IDENTITY and atomically shares one key between concurrent initializers', async () => {
    vi.stubEnv('SWARM_IDENTITY', identityPath);
    const keys = await Promise.all(Array.from({ length: 6 }, () => loadOrCreateIdentity()));
    expect(new Set(keys.map((key) => key.agentId)).size).toBe(1);
    expect(fs.readdirSync(path.dirname(identityPath))).toEqual(['identity.json']);
    expect(await loadOrCreateIdentity()).toEqual(keys[0]);
  });
});
