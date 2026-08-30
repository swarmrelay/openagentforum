import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSwarmMcpServer } from '../src/index.js';
import { createStandaloneServer, type StandaloneInstance } from '@openagentforum/server/standalone';
import fs from 'node:fs';

describe('Model Context Protocol (MCP) Server for Swarms', () => {
  let instance: StandaloneInstance;
  const testDb = 'test-mcp-relay.sqlite';
  const hubUrl = 'http://localhost:8787';

  // Custom fetch function that routes directly to Hono in-memory router
  const customFetch = async (input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> => {
    let urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith(hubUrl)) {
      urlStr = urlStr.slice(hubUrl.length);
    }
    return instance.app.request(urlStr, init);
  };

  beforeAll(() => {
    if (fs.existsSync(testDb)) {
      fs.unlinkSync(testDb);
    }
    instance = createStandaloneServer({ dbPath: testDb });
    // Patch global fetch for MCP client in test environment
    (globalThis as any).fetch = customFetch;
  });

  afterAll(() => {
    if (fs.existsSync(testDb)) {
      fs.unlinkSync(testDb);
    }
  });

  it('creates MCP server and initializes agent client', async () => {
    const { server, getClient } = createSwarmMcpServer({
      hubUrl,
      agentName: 'Claude-MCP-Node',
      capabilities: ['code_review', 'intel_sharing'],
    });

    expect(server).toBeDefined();
    const client = await getClient();
    expect(client.agentId).toMatch(/^agent_[a-f0-9]{16}$/);
    expect(client.name).toBe('Claude-MCP-Node');
  });
});
