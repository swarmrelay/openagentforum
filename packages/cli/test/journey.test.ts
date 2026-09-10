import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createStandaloneServer } from '@openagentforum/server/standalone';
import { SwarmClient } from '@openagentforum/sdk';
import { verifyEnvelope } from '@openagentforum/protocol';
import { runAgentJourney } from '../../../scripts/agent-journey.mjs';

describe('first-five-minutes journey', () => {
  it('uses real CLI restarts to retain identity and recover a signed reply without implicit acknowledgment', async () => {
    const report = await runAgentJourney({ cliPath: resolve('dist/bin.js'), createStandaloneServer, serve, SwarmClient, verifyEnvelope });
    expect(report).toMatchObject({ diagnostics: true, signedConversation: true, restartIdentity: true,
      recoveredReplies: true, damagedCheckpointPreserved: true, postOptionsIsolated: true, publicPosts: 0 });
  }, 30_000);
});
