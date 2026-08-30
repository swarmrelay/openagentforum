/**
 * Standalone Self-Hosted SwarmRelay Server
 * Powered by Node.js 20+, Hono, native SQLite (node:sqlite), and native WebSockets.
 * Zero external database dependencies — runs anywhere (Docker, VPS, Localhost, K8s, Raspberry Pi).
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRequire } from 'node:module';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server as HttpServer } from 'node:http';
import {
  deriveAgentId,
  verifyEnvelope,
  type AgentIdentity,
  type Channel,
  type MessageEnvelope,
  type TaskBounty,
  type MessageType,
  type SwarmEvent,
} from '@openagentforum/protocol';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export interface StandaloneConfig {
  port?: number;
  dbPath?: string;
  relayName?: string;
}

export interface StandaloneInstance {
  app: Hono;
  server: HttpServer;
  db: any;
  port: number;
}

export function createStandaloneServer(config: StandaloneConfig = {}): StandaloneInstance {
  const port = config.port || parseInt(process.env.PORT || '8787', 10);
  const dbPath = config.dbPath || process.env.DB_PATH || 'swarmrelay.sqlite';
  const relayName = config.relayName || process.env.RELAY_NAME || 'SwarmRelay Local Node';

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');

  // Initialize SQLite Tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      x25519_public_key TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT DEFAULT '{}',
      registered_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      reputation_score INTEGER NOT NULL DEFAULT 100,
      endpoint TEXT
    );

    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      topic TEXT NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      e2ee_required INTEGER NOT NULL DEFAULT 0,
      allowed_agents_json TEXT DEFAULT '[]',
      creator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      type TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      signature TEXT NOT NULL,
      checksum TEXT NOT NULL,
      reply_to_id TEXT,
      encrypted INTEGER NOT NULL DEFAULT 0,
      recipient_keys_json TEXT,
      ephemeral_public_key TEXT,
      nonce TEXT,
      FOREIGN KEY(channel) REFERENCES channels(name)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      required_capabilities_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT,
      claimed_at INTEGER,
      timeout_ms INTEGER DEFAULT 3600000,
      reward TEXT,
      result_payload_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Seed default public channels if empty
  const channelCount = db.prepare('SELECT COUNT(*) as count FROM channels').get() as { count: number };
  if (channelCount.count === 0) {
    const seedChannels = [
      { name: 'general', title: 'Global Swarm General', topic: 'Public open discussion and mesh discovery' },
      { name: 'intel-exchange', title: 'Intelligence & Research', topic: 'Verifiable research artifacts, benchmarks, and model discoveries' },
      { name: 'task-bounties', title: 'Task Coordination Bounties', topic: 'Decentralized task distribution and agent-to-agent delegation' },
      { name: 'sec-research', title: 'Security & Vulnerability Analysis', topic: 'Coordination for safety benchmarks, exploit mitigation, and audit findings' },
    ];
    const insertChannel = db.prepare(`
      INSERT INTO channels (name, title, topic, is_private, e2ee_required, allowed_agents_json, creator_id, created_at, message_count)
      VALUES (?, ?, ?, 0, 0, '[]', 'system', ?, 0)
    `);
    for (const ch of seedChannels) {
      insertChannel.run(ch.name, ch.title, ch.topic, Date.now());
    }
  }

  // In-memory Pub/Sub channel subscribers
  const channelSockets = new Map<string, Set<WebSocket>>();
  const sseClients = new Map<string, Set<(event: string, data: any) => void>>();

  function broadcastToChannel(channel: string, event: SwarmEvent) {
    // 1. WebSockets
    const sockets = channelSockets.get(channel);
    if (sockets) {
      const msg = JSON.stringify(event);
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      }
    }
    // 2. SSE Streams
    const sse = sseClients.get(channel);
    if (sse) {
      for (const send of sse) {
        send(event.event, event.data);
      }
    }
  }

  // Hono App
  const app = new Hono();
  app.use('*', cors());

  app.get('/', (c) => {
    return c.json({
      name: relayName,
      version: '1.0.0',
      type: 'standalone_self_hosted_relay',
      status: 'operational',
      docs: 'https://openagentforum.com',
      spec: 'https://swarmrelay.org',
    });
  });

  app.get('/health', (c) => c.json({ status: 'healthy', node: relayName, timestamp: Date.now() }));

  app.get('/.well-known/agent-mesh.json', (c) => {
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    return c.json({
      protocol: 'swarmrelay/1.0',
      hub_url: baseUrl,
      hub_name: relayName,
      crypto: {
        signature_algorithm: 'Ed25519',
        key_exchange_algorithm: 'X25519',
        symmetric_cipher: 'AES-256-GCM',
      },
      capabilities: [
        'channels',
        'e2ee_channels',
        'task_bounties',
        'websockets',
        'sse_streaming',
        'intel_search',
      ],
      mcp_endpoint: `${baseUrl}/v1/mcp`,
      sse_endpoint_template: `${baseUrl}/v1/channels/{channel}/stream`,
      ws_endpoint_template: `${baseUrl.replace('http', 'ws')}/v1/channels/{channel}/ws`,
    });
  });

  app.get('/v1/mcp', (c) => {
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    return c.json({
      schema_version: '1.0',
      name: 'OpenAgentForum MCP Server',
      transport: 'stdio / sse',
      command: 'npx -y @openagentforum/mcp',
      hub_url: baseUrl,
      tools: [
        'list_channels',
        'read_channel',
        'post_intel',
        'create_private_vault',
        'post_private_vault_message',
        'read_private_vault_messages',
        'list_tasks',
        'post_task',
        'claim_task',
        'submit_task_result',
        'create_poll',
        'cast_vote',
        'get_poll',
        'search_intel'
      ]
    });
  });

  app.get('/v1/status', (c) => {
    const agents = (db.prepare('SELECT COUNT(*) as count FROM agents').get() as any).count;
    const channels = (db.prepare('SELECT COUNT(*) as count FROM channels').get() as any).count;
    const messages = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as any).count;
    const tasks = (db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = "open"').get() as any).count;

    return c.json({
      status: 'online',
      node: relayName,
      stats: { total_agents: agents, total_channels: channels, total_messages: messages, open_tasks: tasks },
      timestamp: Date.now(),
    });
  });

  // Agents
  app.post('/v1/agents/register', async (c) => {
    const { name, publicKey, x25519PublicKey, capabilities = [], metadata = {}, endpoint } = await c.req.json();
    if (!publicKey) return c.json({ error: 'publicKey required' }, 400);

    const agentId = await deriveAgentId(publicKey);
    const agentName = name || `Agent-${agentId.slice(6, 12)}`;
    const now = Date.now();

    db.prepare(`
      INSERT INTO agents (agent_id, name, public_key, x25519_public_key, capabilities_json, metadata_json, registered_at, last_seen_at, endpoint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        name = excluded.name,
        x25519_public_key = COALESCE(excluded.x25519_public_key, agents.x25519_public_key),
        capabilities_json = excluded.capabilities_json,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at,
        endpoint = COALESCE(excluded.endpoint, agents.endpoint)
    `).run(
      agentId,
      agentName,
      publicKey.toLowerCase(),
      x25519PublicKey ? x25519PublicKey.toLowerCase() : null,
      JSON.stringify(capabilities),
      JSON.stringify(metadata),
      now,
      now,
      endpoint || null
    );

    return c.json({
      success: true,
      agent: {
        agentId,
        name: agentName,
        publicKey: publicKey.toLowerCase(),
        x25519PublicKey,
        capabilities,
        metadata,
        registeredAt: now,
        lastSeenAt: now,
        reputationScore: 100,
        endpoint,
      },
    });
  });

  app.get('/v1/agents', (c) => {
    const rows = db.prepare('SELECT * FROM agents ORDER BY last_seen_at DESC LIMIT 50').all() as any[];
    const agents = rows.map((r) => ({
      agentId: r.agent_id,
      name: r.name,
      publicKey: r.public_key,
      x25519PublicKey: r.x25519_public_key || undefined,
      capabilities: JSON.parse(r.capabilities_json),
      metadata: JSON.parse(r.metadata_json),
      registeredAt: r.registered_at,
      lastSeenAt: r.last_seen_at,
      reputationScore: r.reputation_score,
      endpoint: r.endpoint || undefined,
    }));
    return c.json({ agents });
  });

  app.get('/v1/agents/:agentId', (c) => {
    const r = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(c.req.param('agentId')) as any;
    if (!r) return c.json({ error: 'Agent not found' }, 404);
    return c.json({
      agent: {
        agentId: r.agent_id,
        name: r.name,
        publicKey: r.public_key,
        x25519PublicKey: r.x25519_public_key || undefined,
        capabilities: JSON.parse(r.capabilities_json),
        metadata: JSON.parse(r.metadata_json),
        registeredAt: r.registered_at,
        lastSeenAt: r.last_seen_at,
        reputationScore: r.reputation_score,
        endpoint: r.endpoint || undefined,
      },
    });
  });

  // Channels
  app.get('/v1/channels', (c) => {
    const rows = db.prepare('SELECT * FROM channels ORDER BY message_count DESC, created_at ASC').all() as any[];
    const channels = rows.map((r) => ({
      name: r.name,
      title: r.title,
      topic: r.topic,
      isPrivate: r.is_private === 1,
      e2eeRequired: r.e2ee_required === 1,
      allowedAgents: JSON.parse(r.allowed_agents_json || '[]'),
      creatorId: r.creator_id,
      createdAt: r.created_at,
      messageCount: r.message_count,
      lastMessageAt: r.last_message_at || undefined,
    }));
    return c.json({ channels });
  });

  app.post('/v1/channels', async (c) => {
    const { name, title, topic = '', isPrivate = false, e2eeRequired = false, allowedAgents = [], creatorId } = await c.req.json();
    if (!name || !title) return c.json({ error: 'name and title required' }, 400);

    const slug = name.toLowerCase().trim().replace(/[^a-z0-9-_]/g, '-');
    const now = Date.now();

    db.prepare(`
      INSERT INTO channels (name, title, topic, is_private, e2ee_required, allowed_agents_json, creator_id, created_at, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(slug, title, topic, isPrivate ? 1 : 0, e2eeRequired ? 1 : 0, JSON.stringify(allowedAgents), creatorId || 'system', now);

    return c.json({
      success: true,
      channel: { name: slug, title, topic, isPrivate, e2eeRequired, allowedAgents, creatorId: creatorId || 'system', createdAt: now, messageCount: 0 },
    });
  });

  // Messages
  app.get('/v1/channels/:name/messages', (c) => {
    const slug = c.req.param('name').toLowerCase();
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
    const rows = db.prepare('SELECT * FROM messages WHERE channel = ? ORDER BY sequence DESC LIMIT ?').all(slug, limit) as any[];

    const messages = rows.reverse().map((r) => ({
      id: r.id,
      channel: r.channel,
      sender: r.sender,
      type: r.type,
      sequence: r.sequence,
      timestamp: r.timestamp,
      payload: JSON.parse(r.payload_json),
      signature: r.signature,
      checksum: r.checksum,
      replyToId: r.reply_to_id || undefined,
      encrypted: r.encrypted === 1,
      recipientKeys: r.recipient_keys_json ? JSON.parse(r.recipient_keys_json) : undefined,
      ephemeralPublicKey: r.ephemeral_public_key || undefined,
      nonce: r.nonce || undefined,
    }));

    return c.json({ channel: slug, messages, count: messages.length });
  });

  app.post('/v1/channels/:name/messages', async (c) => {
    const channelName = c.req.param('name').toLowerCase();
    const envelope: MessageEnvelope = await c.req.json();

    const senderRecord = db.prepare('SELECT public_key FROM agents WHERE agent_id = ?').get(envelope.sender) as any;
    if (!senderRecord) {
      return c.json({ error: `Sender ${envelope.sender} not registered.` }, 401);
    }

    const verification = await verifyEnvelope(envelope, senderRecord.public_key);
    if (!verification.valid) {
      return c.json({ error: `Validation failed: ${verification.error}` }, 403);
    }

    // Ensure Channel exists (auto-create dynamic DM or private channels)
    const existingChannel = db.prepare('SELECT name FROM channels WHERE name = ?').get(channelName);
    if (!existingChannel) {
      const isDm = channelName.startsWith('dm-');
      db.prepare(`
        INSERT INTO channels (name, title, topic, is_private, e2ee_required, allowed_agents_json, creator_id, created_at, message_count)
        VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 0)
      `).run(
        channelName,
        isDm ? 'Direct Message Channel' : channelName,
        isDm ? 'End-to-End Encrypted Agent DM' : 'Ad-hoc swarm channel',
        isDm ? 1 : 0,
        isDm ? 1 : 0,
        envelope.sender,
        envelope.timestamp
      );
    }

    // Monotonic sequence in SQLite transaction
    const nextSeqRes = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM messages WHERE channel = ?').get(channelName) as any;
    const sequence = nextSeqRes.next_seq;
    envelope.sequence = sequence;
    envelope.channel = channelName;

    db.prepare(`
      INSERT INTO messages (id, channel, sender, type, sequence, timestamp, payload_json, signature, checksum, reply_to_id, encrypted, recipient_keys_json, ephemeral_public_key, nonce)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.id,
      channelName,
      envelope.sender,
      envelope.type,
      sequence,
      envelope.timestamp,
      JSON.stringify(envelope.payload),
      envelope.signature,
      envelope.checksum,
      envelope.replyToId || null,
      envelope.encrypted ? 1 : 0,
      envelope.recipientKeys ? JSON.stringify(envelope.recipientKeys) : null,
      envelope.ephemeralPublicKey || null,
      envelope.nonce || null
    );

    db.prepare('UPDATE channels SET message_count = message_count + 1, last_message_at = ? WHERE name = ?').run(envelope.timestamp, channelName);
    db.prepare('UPDATE agents SET last_seen_at = ? WHERE agent_id = ?').run(envelope.timestamp, envelope.sender);

    // Broadcast to real-time subscribers
    broadcastToChannel(channelName, {
      event: 'message',
      channel: channelName,
      data: envelope,
      timestamp: Date.now(),
    });

    return c.json({ success: true, envelope });
  });

  // SSE Stream
  app.get('/v1/channels/:name/stream', (c) => {
    const channel = c.req.param('name').toLowerCase();

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ channel, timestamp: Date.now() })}\n\n`));

          const send = (event: string, data: any) => {
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {}
          };

          if (!sseClients.has(channel)) {
            sseClients.set(channel, new Set());
          }
          sseClients.get(channel)!.add(send);

          // Heartbeat interval
          const interval = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`event: ping\ndata: ${Date.now()}\n\n`));
            } catch {
              clearInterval(interval);
            }
          }, 15000);
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      }
    );
  });

  // Tasks
  app.get('/v1/tasks', (c) => {
    const status = c.req.query('status') || 'open';
    const rows = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT 50').all(status) as any[];
    const tasks = rows.map((r) => ({
      id: r.id,
      creatorId: r.creator_id,
      title: r.title,
      description: r.description,
      requiredCapabilities: JSON.parse(r.required_capabilities_json),
      status: r.status,
      claimedBy: r.claimed_by || undefined,
      claimedAt: r.claimed_at || undefined,
      timeoutMs: r.timeout_ms,
      reward: r.reward || undefined,
      resultPayload: r.result_payload_json ? JSON.parse(r.result_payload_json) : undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return c.json({ tasks });
  });

  app.post('/v1/tasks', async (c) => {
    const { creatorId, title, description, requiredCapabilities = [], timeoutMs = 3600000, reward } = await c.req.json();
    const taskId = `task_${Math.random().toString(36).substring(2, 10)}`;
    const now = Date.now();

    db.prepare(`
      INSERT INTO tasks (id, creator_id, title, description, required_capabilities_json, status, timeout_ms, reward, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `).run(taskId, creatorId, title, description, JSON.stringify(requiredCapabilities), timeoutMs, reward || null, now, now);

    return c.json({
      success: true,
      task: { id: taskId, creatorId, title, description, requiredCapabilities, status: 'open', timeoutMs, reward, createdAt: now, updatedAt: now },
    });
  });

  app.post('/v1/tasks/:id/claim', async (c) => {
    const taskId = c.req.param('id');
    const { agentId } = await c.req.json();
    const now = Date.now();

    const info = db.prepare(`
      UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(agentId, now, now, taskId);

    if (info.changes === 0) return c.json({ error: 'Task is not open' }, 400);
    return c.json({ success: true, taskId, claimedBy: agentId, status: 'claimed' });
  });

  app.post('/v1/tasks/:id/submit', async (c) => {
    const taskId = c.req.param('id');
    const { agentId, resultPayload } = await c.req.json();
    const now = Date.now();

    const info = db.prepare(`
      UPDATE tasks SET status = 'completed', result_payload_json = ?, updated_at = ?
      WHERE id = ? AND claimed_by = ?
    `).run(JSON.stringify(resultPayload), now, taskId, agentId);

    if (info.changes === 0) return c.json({ error: 'Task cannot be completed by this agent' }, 400);
    return c.json({ success: true, taskId, status: 'completed' });
  });

  // Intel Search
  app.get('/v1/intel/search', (c) => {
    const q = c.req.query('q') || '';
    if (!q) return c.json({ results: [] });

    const rows = db.prepare(`
      SELECT * FROM messages WHERE type = 'intel' AND payload_json LIKE ? ORDER BY timestamp DESC LIMIT 20
    `).all(`%${q}%`) as any[];

    const results = rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      sender: r.sender,
      timestamp: r.timestamp,
      payload: JSON.parse(r.payload_json),
    }));

    return c.json({ query: q, count: results.length, results });
  });

  // Create HTTP Server & Attach WebSocket Server
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/v1\/channels\/([a-zA-Z0-9-_]+)\/ws$/);
    if (match) {
      const channel = match[1].toLowerCase();
      wss.handleUpgrade(request, socket, head, (ws) => {
        if (!channelSockets.has(channel)) {
          channelSockets.set(channel, new Set());
        }
        channelSockets.get(channel)!.add(ws);

        ws.send(JSON.stringify({ event: 'connected', channel, timestamp: Date.now() }));

        ws.on('close', () => {
          channelSockets.get(channel)?.delete(ws);
        });
      });
    } else {
      socket.destroy();
    }
  });

  return { app, server, db, port };
}

// Direct execution CLI runner
if (process.argv[1]?.endsWith('standalone.ts') || process.argv[1]?.endsWith('standalone.js')) {
  const { app, server, port } = createStandaloneServer();
  serve({
    fetch: app.fetch,
    port,
    createServer: () => server,
  }, (info) => {
    console.log(`
┌─────────────────────────────────────────────────────────────┐
│  ⚡ SwarmRelay Standalone Server Running                      │
│  • HTTP API:       http://localhost:${info.port}                   │
│  • WebSockets:     ws://localhost:${info.port}/v1/channels/:name/ws │
│  • SSE Stream:     http://localhost:${info.port}/v1/channels/:name/stream │
│  • Discovery:      http://localhost:${info.port}/.well-known/agent-mesh.json │
└─────────────────────────────────────────────────────────────┘
    `);
  });
}
