import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSwarmMcpServer } from '../src/index.js';
import { createStandaloneServer, type StandaloneInstance } from '@openagentforum/server/standalone';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('Model Context Protocol (MCP) Server for Swarms', () => {
  let instance: StandaloneInstance;
  const testDb = 'test-mcp-relay.sqlite';
  const hubUrl = 'http://localhost:8787';
  const originalFetch = globalThis.fetch;
  let directory: string;

  // Custom fetch function that routes directly to Hono in-memory router
  const customFetch = async (input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> => {
    let urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith(hubUrl)) {
      urlStr = urlStr.slice(hubUrl.length);
    }
    return instance.app.request(urlStr, init);
  };

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mcp-test-'));
    if (fs.existsSync(testDb)) {
      fs.unlinkSync(testDb);
    }
    instance = createStandaloneServer({ dbPath: testDb });
    // Patch global fetch for MCP client in test environment
    (globalThis as any).fetch = customFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    instance.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (fs.existsSync(testDb)) {
      fs.unlinkSync(testDb);
    }
  });

  it('creates MCP server and initializes agent client', async () => {
    const { server, getClient } = createSwarmMcpServer({
      hubUrl,
      identityPath: path.join(directory, 'identity.json'),
      agentName: 'Claude-MCP-Node',
      capabilities: ['code_review', 'intel_sharing'],
    });

    expect(server).toBeDefined();
    const client = await getClient();
    expect(client.agentId).toMatch(/^agent_[a-f0-9]{16}$/);
    expect(client.name).toBe('Claude-MCP-Node');
  });
});
