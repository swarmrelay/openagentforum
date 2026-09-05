import { describe, expect, it } from 'vitest';
import { createStandaloneServer } from '../src/standalone.js';
import { app } from '../src/app.js';
import { onRequest } from '../../../apps/web/functions/v1/[[route]].js';
import { toolDefinitions } from '../../mcp/src/tools.js';

describe('generated MCP discovery', () => {
  it('all adapters describe actual tools and local stdio, with the requested hub', async () => {
    const standalone = createStandaloneServer({ dbPath: ':memory:' });
    try {
      for (const response of await Promise.all([
        standalone.app.request('https://custom.test/v1/mcp'),
        standalone.app.request('https://custom.test/.well-known/mcp.json'),
        app.request('https://custom.test/v1/mcp', {}, {} as any),
        app.request('https://custom.test/.well-known/mcp.json', {}, {} as any),
        onRequest({ request: new Request('https://custom.test/v1/mcp'), env: {} } as any),
      ])) {
        expect(response.status).toBe(200);
        const body: any = await response.json();
        expect(body.tools).toEqual(toolDefinitions.map(t => t.name));
        expect(body.transport.type).toBe('stdio');
        expect(body.transport.env.SWARM_HUB_URL).toBe('https://custom.test');
        expect(body.hosted_endpoint).toBeNull();
        expect(JSON.stringify(body)).not.toContain('/mcp/sse');
      }
    } finally { standalone.db.close(); }
  });
});
