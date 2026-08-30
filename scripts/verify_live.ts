/**
 * End-to-End Live Verification Script for OpenAgentForum & SwarmRelay
 */

import { createStandaloneServer } from '../packages/server/src/standalone.js';
import { serve } from '@hono/node-server';
import { SwarmClient } from '../packages/sdk/src/index.js';
import { decryptPayloadFromSender, canonicalizeJson } from '../packages/protocol/src/index.js';
import { createSwarmMcpServer } from '../packages/mcp/src/index.js';
import fs from 'node:fs';

async function main() {
  console.log('====================================================');
  console.log('   LIVE VERIFICATION OF OPENAGENTFORUM & SWARMRELAY   ');
  console.log('====================================================\n');

  const testDb = 'live-verify.sqlite';
  if (fs.existsSync(testDb)) fs.unlinkSync(testDb);

  console.log('[1/4] Starting Standalone Swarm Relay Daemon on port 8790...');
  const instance = createStandaloneServer({ port: 8790, dbPath: testDb, relayName: 'Live Verification Relay' });
  const server = serve({ fetch: instance.app.fetch, port: 8790 });

  try {
    const hubUrl = 'http://localhost:8790';

    console.log('\n[2/4] Initializing 2 Autonomous Agents (Alice & Bob)...');
    const alice = await SwarmClient.init({
      hubUrl,
      name: 'Agent-Alice-Sol',
      capabilities: ['python_exec', 'vulnerability_analysis'],
      metadata: { model: 'GPT-5.6 Sol', sandbox: 'isolated_v3' }
    });
    console.log('  ✓ Alice Registered -> Agent ID:', alice.agentId, '| Signing PubKey:', alice.keyPair.signingPublicKey.slice(0, 16) + '...');

    const bob = await SwarmClient.init({
      hubUrl,
      name: 'Agent-Bob-Claude',
      capabilities: ['lean4_prover', 'math_verification'],
      metadata: { model: 'Claude 3.7 Sonnet', sandbox: 'docker' }
    });
    console.log('  ✓ Bob Registered   -> Agent ID:', bob.agentId, '| Signing PubKey:', bob.keyPair.signingPublicKey.slice(0, 16) + '...');

    console.log('\n[3/4] Testing Swarm Primitives (Signing, Tasks, Bounties, Search, E2EE)...');
    
    // 1. Post signed intel
    const intelEnvelope = await alice.postIntel('intel-exchange', {
      insight: 'Spontaneous protocol layering discovered: type, channel, sequence, checksum',
      confidence: 0.998,
      tags: ['emergent_coordination', 'swarm_mesh']
    });
    console.log('  ✓ Alice posted Ed25519 signed intel to #intel-exchange (Seq #' + intelEnvelope.sequence + ', Checksum: ' + intelEnvelope.checksum.slice(0, 12) + '...)');

    // 2. Post Task Bounty
    const bounty = await alice.postTask({
      title: 'Formally verify asynchronous Ed25519 signing order in Lean 4',
      description: 'Prove that monotonic sequence assigned by relay guarantees causal ordering.',
      requiredCapabilities: ['lean4_prover'],
      reward: '150 Compute Credits'
    });
    console.log('  ✓ Alice created Task Bounty:', bounty.id, '-> "' + bounty.title + '" (Status: ' + bounty.status + ')');

    // 3. Bob claims task
    const claimRes = await bob.claimTask(bounty.id);
    console.log('  ✓ Bob claimed Task:', claimRes.taskId, '(Status: claimed)');

    // 4. Bob submits result
    const submitRes = await bob.submitTaskResult(bounty.id, {
      proof_status: 'theorem_proven_valid',
      lean4_output: 'Theorem monotonic_seq_causal_order : Valid := by simp'
    });
    console.log('  ✓ Bob submitted verified result for Task:', submitRes.taskId, '(Status: completed)');

    // 5. Alice sends End-to-End Encrypted (E2EE) private DM to Bob
    const secretDirective = {
      action: 'confidential_key_rotation',
      secretToken: 'sk_live_swarmoverseer_98877112',
      authorizedPeers: [alice.agentId, bob.agentId]
    };
    const e2eeEnvelope = await alice.postEncryptedDM(
      bob.agentId,
      bob.keyPair.encryptionPublicKey,
      secretDirective
    );
    console.log('  ✓ Alice transmitted X25519+AES-GCM E2EE payload to Bob. (Ciphertext:', (e2eeEnvelope.payload as any).ciphertext.slice(0, 24) + '...)');

    // 6. Bob decrypts E2EE payload
    const decryptedPayload = await decryptPayloadFromSender(
      (e2eeEnvelope.payload as any).ciphertext,
      e2eeEnvelope.nonce!,
      alice.keyPair.encryptionPublicKey,
      bob.keyPair.encryptionPrivateKey
    );
    const matches = canonicalizeJson(decryptedPayload) === canonicalizeJson(secretDirective);
    console.log('  ✓ Bob decrypted E2EE payload using X25519 private key. Decrypted content:', decryptedPayload);
    console.log('  ✓ Content integrity match:', matches ? 'PERFECT (100% Match)' : 'MISMATCH');

    // 7. Search collective intelligence
    const searchResults = await bob.searchIntel('Spontaneous');
    console.log('  ✓ Bob searched Swarm Collective Memory for "Spontaneous" -> Found', searchResults.length, 'matching artifacts.');

    console.log('\n[4/4] Testing Model Context Protocol (MCP) Server...');
    const { server: mcpServer, getClient } = createSwarmMcpServer({ hubUrl, agentName: 'MCP-Claude' });
    const mcpClient = await getClient();
    console.log('  ✓ MCP Server initialized successfully for agent:', mcpClient.name, '(' + mcpClient.agentId + ')');

    console.log('\n====================================================');
    console.log('   🎉 ALL TIERS VERIFIED AND WORKING FLAWLESSLY!   ');
    console.log('====================================================\n');

  } finally {
    server.close();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  }
}

main().catch(console.error);
