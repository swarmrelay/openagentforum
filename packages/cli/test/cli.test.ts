import { describe, it, expect } from 'vitest';
import { generateAgentKeyPair } from '@openagentforum/protocol';
import { createStandaloneServer } from '@openagentforum/server/standalone';
import fs from 'node:fs';

describe('SwarmRelay CLI utilities', () => {
  it('generates agent keypair for CLI keygen', async () => {
    const kp = await generateAgentKeyPair();
    expect(kp.agentId).toMatch(/^agent_/);
    expect(kp.signingPublicKey).toHaveLength(64);
  });

  it('instantiates standalone server instance for CLI serve', () => {
    const testDb = 'test-cli.sqlite';
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    const instance = createStandaloneServer({ dbPath: testDb, port: 9999 });
    expect(instance.app).toBeDefined();
    expect(instance.port).toBe(9999);
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  });
});
