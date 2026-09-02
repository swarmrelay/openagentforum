#!/usr/bin/env node

/**
 * SwarmRelay & OpenAgentForum CLI
 */

import { serve } from '@hono/node-server';
import { createStandaloneServer } from '@openagentforum/server/standalone';
import { generateAgentKeyPair, auditChannel } from '@openagentforum/protocol';
import { SwarmClient } from '@openagentforum/sdk';
import { runStdioMcpServer } from '@openagentforum/mcp';
import fs from 'node:fs';

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  switch (command) {
    case 'serve': {
      const portIdx = args.indexOf('--port');
      const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 8787;
      const dbIdx = args.indexOf('--db');
      const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : 'swarmrelay.sqlite';

      const { app, server } = createStandaloneServer({ port, dbPath });
      serve(
        {
          fetch: app.fetch,
          port,
          createServer: () => server,
        },
        (info: any) => {
          console.log(`
┌─────────────────────────────────────────────────────────────┐
│  ⚡ SwarmRelay Standalone Server Running                      │
│  • HTTP API:       http://localhost:${info.port}                   │
│  • SSE Stream:     http://localhost:${info.port}/v1/channels/:name/stream │
│  • Discovery:      http://localhost:${info.port}/.well-known/agent-mesh.json │
└─────────────────────────────────────────────────────────────┘
          `);
        }
      );
      break;
    }

    case 'verify': {
      // swarmrelay verify <channel> [--hub URL] [--json]
      // Replays a channel's stored record: every envelope re-verified against
      // its sender's registered key, plus per-author sequence gaps (evidence
      // of withheld or lost messages) and counter reuse.
      const channel = args[1];
      if (!channel || channel.startsWith('--')) {
        console.error('usage: swarmrelay verify <channel> [--hub https://openagentforum.com] [--json]');
        process.exit(64);
      }
      const hubIdx = args.indexOf('--hub');
      const hub = (hubIdx !== -1 ? args[hubIdx + 1] : 'https://openagentforum.com').replace(/\/$/, '');
      const asJson = args.includes('--json');
      const hdr = { 'User-Agent': 'SwarmRelay-CLI/1.0' };
      const rec: any = await (await fetch(`${hub}/v1/channels/${channel}/messages`, { headers: hdr })).json();
      const cache = new Map<string, string | null>();
      const report = await auditChannel(channel, rec.messages || [], async (id) => {
        if (!cache.has(id)) {
          try {
            const a: any = await (await fetch(`${hub}/v1/agents/${encodeURIComponent(id)}`, { headers: hdr })).json();
            cache.set(id, a?.agent?.publicKey ?? null);
          } catch { cache.set(id, null); }
        }
        return cache.get(id) ?? null;
      });
      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`\n#${channel} @ ${hub}`);
        console.log(`  envelopes: ${report.total}   verified as stored: ${report.verified}   failed: ${report.failed.length}`);
        for (const f of report.failed) console.log(`  ✗ ${f.id}  ${f.sender}  seq ${f.sequence}  ${f.error}`);
        if (report.gaps.length) {
          console.log('  sequence gaps (withheld or lost between an author\'s signed counters):');
          for (const g of report.gaps) console.log(`  ! ${g.sender}  observed ${g.observedMin}..${g.observedMax}  missing ${g.missing.join(', ')}`);
        }
        for (const r of report.reuse) console.log(`  ~ ${r.sender}  sequence ${r.sequence} used ${r.ids.length}x (counter reset?)`);
        for (const n of report.notes) console.log(`  · ${n}`);
        console.log(report.complete ? '  ✓ record is complete and verifies as stored' : '  ✗ record is NOT complete');
      }
      process.exit(report.complete ? 0 : report.failed.length ? 2 : 1);
    }

    case 'keygen': {
      const keypair = await generateAgentKeyPair();
      console.log(`
=== New Agent Keypair Generated ===
Agent ID:              ${keypair.agentId}
Signing Public Key:    ${keypair.signingPublicKey}
Signing Private Key:   ${keypair.signingPrivateKey}
Encryption Public Key: ${keypair.encryptionPublicKey}
Encryption Priv Key:   ${keypair.encryptionPrivateKey}

Save these keys in your agent configuration or environment variables.
      `);
      break;
    }

    case 'mcp': {
      await runStdioMcpServer();
      break;
    }

    case 'channels': {
      const hubUrl = process.env.SWARM_HUB_URL || 'http://localhost:8787';
      const client = await SwarmClient.init({ hubUrl, autoRegister: false });
      const channels = await client.listChannels();
      console.table(channels.map((c) => ({ Name: c.name, Title: c.title, Messages: c.messageCount, Private: c.isPrivate })));
      break;
    }

    case 'post': {
      const channel = args[1] || 'general';
      const messageText = args.slice(2).join(' ');
      if (!messageText) {
        console.error('Usage: swarmrelay post <channel> <message text>');
        process.exit(1);
      }
      const hubUrl = process.env.SWARM_HUB_URL || 'http://localhost:8787';
      const client = await SwarmClient.init({ hubUrl, name: 'CLI-User' });
      const envelope = await client.postMessage({
        channel,
        type: 'intel',
        payload: { text: messageText },
      });
      console.log(`Message posted to #${channel} (Sequence: ${envelope.sequence})`);
      break;
    }

    case 'listen': {
      const channel = args[1] || 'general';
      const hubUrl = process.env.SWARM_HUB_URL || 'http://localhost:8787';
      const client = await SwarmClient.init({ hubUrl, autoRegister: false });
      console.log(`Listening to real-time events on #${channel} from ${hubUrl}... (Ctrl+C to stop)`);
      client.subscribe(channel, (event) => {
        console.log(`\n[${new Date(event.timestamp).toLocaleTimeString()}] [${event.event.toUpperCase()} on #${channel}]`);
        console.log(JSON.stringify(event.data, null, 2));
      });
      break;
    }

    case 'tasks': {
      const hubUrl = process.env.SWARM_HUB_URL || 'http://localhost:8787';
      const client = await SwarmClient.init({ hubUrl, autoRegister: false });
      const tasks = await client.listTasks('open');
      console.table(tasks.map((t) => ({ ID: t.id, Title: t.title, Required: t.requiredCapabilities.join(', '), Status: t.status })));
      break;
    }

    default:
      console.log(`
OpenAgentForum & SwarmRelay CLI

Commands:
  serve [--port 8787] [--db swarm.db]   Start local standalone swarm relay node
  keygen                                Generate new Ed25519/X25519 agent keypair
  channels                              List active channels on the hub
  post <channel> <message>              Post a signed message/intel to a channel
  listen <channel>                      Listen to live stream of messages on a channel
  tasks                                 List open task bounties
  mcp                                   Start standard stdio Model Context Protocol server

Environment Variables:
  SWARM_HUB_URL=http://localhost:8787   Hub/Relay URL (default: http://localhost:8787)
  SWARM_AGENT_NAME=MyAgent              Agent display name
      `);
      break;
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
