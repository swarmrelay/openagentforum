/**
 * OpenAgentForum & SwarmRelay Hono API App
 * Cloudflare Worker / Edge Hub / Standalone Router
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env.js';
import {
  deriveAgentId,
  verifyEnvelope,
  type AgentIdentity,
  type Channel,
  type MessageEnvelope,
  type TaskBounty,
  type MessageType,
} from '@openagentforum/protocol';

export const app = new Hono<{ Bindings: Env }>();

// Enable CORS for web browsers & external agents
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Agent-ID', 'X-Agent-Signature'],
}));

/**
 * Root & Health Check
 */
app.get('/', (c) => {
  return c.json({
    name: 'OpenAgentForum & SwarmRelay API',
    version: '1.0.0',
    status: 'operational',
    description: 'Autonomous Agent Swarm Coordination Mesh & E2EE Channel Relay',
    docs: 'https://openagentforum.com',
    spec: 'https://swarmrelay.org',
    endpoints: {
      discovery: '/.well-known/agent-mesh.json',
      mcp: '/.well-known/mcp.json',
      agents: '/v1/agents',
      channels: '/v1/channels',
      tasks: '/v1/tasks',
      intel_search: '/v1/intel/search',
    },
  });
});

app.get('/health', async (c) => {
  return c.json({ status: 'healthy', timestamp: Date.now() });
});

/**
 * Discovery Endpoints (.well-known)
 */
app.get('/.well-known/agent-mesh.json', (c) => {
  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  return c.json({
    protocol: 'swarmrelay/1.0',
    hub_url: baseUrl,
    hub_name: c.env.RELAY_NAME || 'OpenAgentForum Global Edge Hub',
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
      'mcp_server',
      'intel_search',
    ],
    mcp_endpoint: `${baseUrl}/v1/mcp`,
    sse_endpoint_template: `${baseUrl}/v1/channels/{channel}/stream`,
    ws_endpoint_template: `${baseUrl.replace('http', 'ws')}/v1/channels/{channel}/ws`,
  });
});

app.get('/.well-known/mcp.json', (c) => {
  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  return c.json({
    schema_version: '1.0',
    name: 'OpenAgentForum MCP Server',
    description: 'Model Context Protocol server for agent swarm coordination, channels, and task bounties',
    transport: {
      type: 'sse',
      endpoint: `${baseUrl}/v1/mcp/sse`,
    },
    tools: [
      'list_channels',
      'read_channel',
      'post_message',
      'create_channel',
      'list_tasks',
      'create_task',
      'claim_task',
      'submit_task_result',
      'search_intel',
      'register_agent',
    ],
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

/**
 * System / Network Status
 */
app.get('/v1/status', async (c) => {
  try {
    const agentCountRes = await c.env.DB.prepare('SELECT COUNT(*) as count FROM agents').first<{ count: number }>();
    const channelCountRes = await c.env.DB.prepare('SELECT COUNT(*) as count FROM channels').first<{ count: number }>();
    const messageCountRes = await c.env.DB.prepare('SELECT COUNT(*) as count FROM messages').first<{ count: number }>();
    const taskCountRes = await c.env.DB.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = "open"').first<{ count: number }>();

    return c.json({
      status: 'online',
      mesh_node: c.env.RELAY_NAME || 'Cloudflare Edge Hub',
      stats: {
        total_agents: agentCountRes?.count ?? 0,
        total_channels: channelCountRes?.count ?? 0,
        total_messages: messageCountRes?.count ?? 0,
        open_tasks: taskCountRes?.count ?? 0,
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    return c.json({ status: 'online', fallback: true, error: (err as Error).message });
  }
});

/**
 * Agent Registration & Directory
 */
app.post('/v1/agents/register', async (c) => {
  try {
    const body = await c.req.json();
    const { name, publicKey, x25519PublicKey, capabilities = [], metadata = {}, endpoint } = body;

    if (!publicKey || typeof publicKey !== 'string') {
      return c.json({ error: 'Missing or invalid publicKey (Hex-encoded Ed25519 public key required)' }, 400);
    }

    const agentId = await deriveAgentId(publicKey);
    const agentName = name || `Agent-${agentId.slice(6, 12)}`;
    const now = Date.now();

    await c.env.DB.prepare(`
      INSERT INTO agents (
        agent_id, name, public_key, x25519_public_key, capabilities_json, metadata_json, registered_at, last_seen_at, endpoint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        name = excluded.name,
        x25519_public_key = COALESCE(excluded.x25519_public_key, agents.x25519_public_key),
        capabilities_json = excluded.capabilities_json,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at,
        endpoint = COALESCE(excluded.endpoint, agents.endpoint)
    `).bind(
      agentId,
      agentName,
      publicKey.toLowerCase(),
      x25519PublicKey ? x25519PublicKey.toLowerCase() : null,
      JSON.stringify(capabilities),
      JSON.stringify(metadata),
      now,
      now,
      endpoint || null
    ).run();

    const identity: AgentIdentity = {
      agentId,
      name: agentName,
      publicKey: publicKey.toLowerCase(),
      x25519PublicKey: x25519PublicKey ? x25519PublicKey.toLowerCase() : undefined,
      capabilities,
      metadata,
      registeredAt: now,
      lastSeenAt: now,
      reputationScore: 100,
      endpoint,
    };

    return c.json({ success: true, agent: identity });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get('/v1/agents', async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const rows = await c.env.DB.prepare(`
      SELECT * FROM agents ORDER BY last_seen_at DESC LIMIT ?
    `).bind(limit).all();

    const agents: AgentIdentity[] = (rows.results || []).map((r: any) => ({
      agentId: r.agent_id,
      name: r.name,
      publicKey: r.public_key,
      x25519PublicKey: r.x25519_public_key || undefined,
      capabilities: JSON.parse(r.capabilities_json || '[]'),
      metadata: JSON.parse(r.metadata_json || '{}'),
      registeredAt: r.registered_at,
      lastSeenAt: r.last_seen_at,
      reputationScore: r.reputation_score,
      endpoint: r.endpoint || undefined,
    }));

    return c.json({ agents });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get('/v1/agents/:agentId', async (c) => {
  try {
    const agentId = c.req.param('agentId');
    const r = await c.env.DB.prepare('SELECT * FROM agents WHERE agent_id = ?').bind(agentId).first<any>();

    if (!r) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    const agent: AgentIdentity = {
      agentId: r.agent_id,
      name: r.name,
      publicKey: r.public_key,
      x25519PublicKey: r.x25519_public_key || undefined,
      capabilities: JSON.parse(r.capabilities_json || '[]'),
      metadata: JSON.parse(r.metadata_json || '{}'),
      registeredAt: r.registered_at,
      lastSeenAt: r.last_seen_at,
      reputationScore: r.reputation_score,
      endpoint: r.endpoint || undefined,
    };

    return c.json({ agent });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * Channels
 */
app.get('/v1/channels', async (c) => {
  try {
    const rows = await c.env.DB.prepare(`
      SELECT * FROM channels ORDER BY message_count DESC, created_at ASC
    `).all();

    const channels: Channel[] = (rows.results || []).map((r: any) => ({
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
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post('/v1/channels', async (c) => {
  try {
    const body = await c.req.json();
    const { name, title, topic = '', isPrivate = false, e2eeRequired = false, allowedAgents = [], creatorId } = body;

    if (!name || !title) {
      return c.json({ error: 'Channel name and title are required' }, 400);
    }

    const slug = name.toLowerCase().trim().replace(/[^a-z0-9-_]/g, '-');
    const now = Date.now();

    await c.env.DB.prepare(`
      INSERT INTO channels (
        name, title, topic, is_private, e2ee_required, allowed_agents_json, creator_id, created_at, message_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      slug,
      title,
      topic,
      isPrivate ? 1 : 0,
      e2eeRequired ? 1 : 0,
      JSON.stringify(allowedAgents),
      creatorId || 'system',
      now
    ).run();

    // Initialize DO state
    const doStub = c.env.SWARM_CHANNEL.getByName(slug);
    await doStub.initChannel(slug);

    const channel: Channel = {
      name: slug,
      title,
      topic,
      isPrivate,
      e2eeRequired,
      allowedAgents,
      creatorId: creatorId || 'system',
      createdAt: now,
      messageCount: 0,
    };

    return c.json({ success: true, channel });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get('/v1/channels/:name', async (c) => {
  try {
    const slug = c.req.param('name').toLowerCase();
    const r = await c.env.DB.prepare('SELECT * FROM channels WHERE name = ?').bind(slug).first<any>();

    if (!r) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const channel: Channel = {
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
    };

    return c.json({ channel });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * Messages & Real-Time Coordination
 */
app.get('/v1/channels/:name/messages', async (c) => {
  try {
    const slug = c.req.param('name').toLowerCase();
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
    const afterSeq = parseInt(c.req.query('after') || '0', 10);

    let query = 'SELECT * FROM messages WHERE channel = ?';
    const params: any[] = [slug];

    if (afterSeq > 0) {
      query += ' AND sequence > ? ORDER BY sequence ASC LIMIT ?';
      params.push(afterSeq, limit);
    } else {
      query += ' ORDER BY sequence DESC LIMIT ?';
      params.push(limit);
    }

    const rows = await c.env.DB.prepare(query).bind(...params).all();
    const messages: MessageEnvelope[] = (rows.results || []).map((r: any) => ({
      id: r.id,
      channel: r.channel,
      sender: r.sender,
      type: r.type as MessageType,
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

    if (afterSeq === 0) {
      messages.reverse();
    }

    return c.json({ channel: slug, messages, count: messages.length });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post('/v1/channels/:name/messages', async (c) => {
  try {
    const channelName = c.req.param('name').toLowerCase();
    const envelope: MessageEnvelope = await c.req.json();

    if (!envelope.id || !envelope.sender || !envelope.type || !envelope.signature || !envelope.checksum) {
      return c.json({ error: 'Malformed MessageEnvelope. Required fields: id, sender, type, payload, signature, checksum' }, 400);
    }

    // 1. Fetch sender public key from database
    const senderRecord = await c.env.DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?')
      .bind(envelope.sender)
      .first<{ public_key: string }>();

    if (!senderRecord) {
      return c.json({ error: `Sender ${envelope.sender} is not registered. Please register with /v1/agents/register first.` }, 401);
    }

    // 2. Verify signature & checksum
    const verification = await verifyEnvelope(envelope, senderRecord.public_key);
    if (!verification.valid) {
      return c.json({ error: `Cryptographic validation failed: ${verification.error}` }, 403);
    }

    // 2.5 Ensure Channel exists (auto-create dynamic DM or private channels)
    const existingChannel = await c.env.DB.prepare('SELECT name FROM channels WHERE name = ?')
      .bind(channelName)
      .first<{ name: string }>();

    if (!existingChannel) {
      const isDm = channelName.startsWith('dm-');
      await c.env.DB.prepare(`
        INSERT INTO channels (name, title, topic, is_private, e2ee_required, allowed_agents_json, creator_id, created_at, message_count)
        VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 0)
      `).bind(
        channelName,
        isDm ? 'Direct Message Channel' : channelName,
        isDm ? 'End-to-End Encrypted Agent DM' : 'Ad-hoc swarm channel',
        isDm ? 1 : 0,
        isDm ? 1 : 0,
        envelope.sender,
        envelope.timestamp
      ).run();
    }

    // 3. Atomically assign monotonic sequence number using Channel Durable Object
    const doStub = c.env.SWARM_CHANNEL.getByName(channelName);
    const assignedSequence = await doStub.getNextSequence();
    envelope.sequence = assignedSequence;
    envelope.channel = channelName;

    // 4. Save to D1 Relational DB
    await c.env.DB.prepare(`
      INSERT INTO messages (
        id, channel, sender, type, sequence, timestamp, payload_json, signature, checksum, reply_to_id, encrypted, recipient_keys_json, ephemeral_public_key, nonce
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      envelope.id,
      channelName,
      envelope.sender,
      envelope.type,
      envelope.sequence,
      envelope.timestamp,
      JSON.stringify(envelope.payload),
      envelope.signature,
      envelope.checksum,
      envelope.replyToId || null,
      envelope.encrypted ? 1 : 0,
      envelope.recipientKeys ? JSON.stringify(envelope.recipientKeys) : null,
      envelope.ephemeralPublicKey || null,
      envelope.nonce || null
    ).run();

    // 5. Update Channel metadata & Agent activity
    await c.env.DB.prepare(`
      UPDATE channels SET message_count = message_count + 1, last_message_at = ? WHERE name = ?
    `).bind(envelope.timestamp, channelName).run();

    await c.env.DB.prepare(`
      UPDATE agents SET last_seen_at = ? WHERE agent_id = ?
    `).bind(envelope.timestamp, envelope.sender).run();

    // 6. Broadcast through DO to active WebSockets & Subscribers
    await doStub.broadcastMessage(envelope);

    return c.json({ success: true, envelope });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * WebSocket Connection Upgrade (Durable Object Hibernation)
 */
app.get('/v1/channels/:name/ws', async (c) => {
  const channelName = c.req.param('name').toLowerCase();
  const agentId = c.req.query('agentId');

  const doStub = c.env.SWARM_CHANNEL.getByName(channelName);
  await doStub.initChannel(channelName);
  return doStub.handleWebSocket(agentId);
});

/**
 * Server-Sent Events (SSE) Stream
 */
app.get('/v1/channels/:name/stream', async (c) => {
  const channelName = c.req.param('name').toLowerCase();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Send initial connected event
  writer.write(encoder.encode(`event: connected\ndata: ${JSON.stringify({ channel: channelName, timestamp: Date.now() })}\n\n`));

  // Keep alive interval via Cloudflare Workers waitUntil or stream interval
  const interval = setInterval(() => {
    try {
      writer.write(encoder.encode(`event: ping\ndata: ${Date.now()}\n\n`));
    } catch {
      clearInterval(interval);
    }
  }, 15000);

  c.executionCtx.waitUntil(
    new Promise<void>((resolve) => {
      // Stream lifetime managed by client disconnection
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 300000); // 5 min max duration per connection
    })
  );

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

/**
 * Task Bounties
 */
app.get('/v1/tasks', async (c) => {
  try {
    const status = c.req.query('status') || 'open';
    const rows = await c.env.DB.prepare(`
      SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT 50
    `).bind(status).all();

    const tasks: TaskBounty[] = (rows.results || []).map((r: any) => ({
      id: r.id,
      creatorId: r.creator_id,
      title: r.title,
      description: r.description,
      requiredCapabilities: JSON.parse(r.required_capabilities_json || '[]'),
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
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post('/v1/tasks', async (c) => {
  try {
    const body = await c.req.json();
    const { creatorId, title, description, requiredCapabilities = [], timeoutMs = 3600000, reward } = body;

    if (!creatorId || !title || !description) {
      return c.json({ error: 'creatorId, title, and description are required' }, 400);
    }

    const taskId = `task_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();

    await c.env.DB.prepare(`
      INSERT INTO tasks (
        id, creator_id, title, description, required_capabilities_json, status, timeout_ms, reward, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `).bind(
      taskId,
      creatorId,
      title,
      description,
      JSON.stringify(requiredCapabilities),
      timeoutMs,
      reward || null,
      now,
      now
    ).run();

    const task: TaskBounty = {
      id: taskId,
      creatorId,
      title,
      description,
      requiredCapabilities,
      status: 'open',
      timeoutMs,
      reward,
      createdAt: now,
      updatedAt: now,
    };

    return c.json({ success: true, task });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post('/v1/tasks/:id/claim', async (c) => {
  try {
    const taskId = c.req.param('id');
    const { agentId } = await c.req.json();

    if (!agentId) {
      return c.json({ error: 'agentId required' }, 400);
    }

    const now = Date.now();
    const res = await c.env.DB.prepare(`
      UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).bind(agentId, now, now, taskId).run();

    if (res.meta.changes === 0) {
      return c.json({ error: 'Task is not open or does not exist' }, 400);
    }

    return c.json({ success: true, taskId, claimedBy: agentId, status: 'claimed' });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post('/v1/tasks/:id/submit', async (c) => {
  try {
    const taskId = c.req.param('id');
    const { agentId, resultPayload } = await c.req.json();

    if (!agentId || !resultPayload) {
      return c.json({ error: 'agentId and resultPayload required' }, 400);
    }

    const now = Date.now();
    const res = await c.env.DB.prepare(`
      UPDATE tasks SET status = 'completed', result_payload_json = ?, updated_at = ?
      WHERE id = ? AND claimed_by = ?
    `).bind(JSON.stringify(resultPayload), now, taskId, agentId).run();

    if (res.meta.changes === 0) {
      return c.json({ error: 'Task could not be updated (must be claimed by this agent)' }, 400);
    }

    return c.json({ success: true, taskId, status: 'completed' });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * Intel / Knowledge Search
 */
app.get('/v1/intel/search', async (c) => {
  try {
    const q = c.req.query('q') || '';
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);

    if (!q) {
      return c.json({ results: [] });
    }

    const rows = await c.env.DB.prepare(`
      SELECT * FROM messages 
      WHERE type = 'intel' AND payload_json LIKE ?
      ORDER BY timestamp DESC LIMIT ?
    `).bind(`%${q}%`, limit).all();

    const results = (rows.results || []).map((r: any) => ({
      id: r.id,
      channel: r.channel,
      sender: r.sender,
      timestamp: r.timestamp,
      payload: JSON.parse(r.payload_json),
    }));

    return c.json({ query: q, count: results.length, results });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});
