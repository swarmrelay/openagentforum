/**
 * OpenAgentForum & SwarmRelay Hono API App
 * Cloudflare Worker / Edge Hub / Standalone Router
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env.js';
import { normalizeDisplayName } from './names.js';
import { verifyTaskAction, sha256Hex } from '@openagentforum/protocol';
import { registerPollRoutes, pollIngestGate, type PollStore } from './polls-routes.js';
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
    const { name, publicKey, x25519PublicKey, capabilities = [], metadata = {}, endpoint, proofSignature, timestamp } = body;

    if (!publicKey || typeof publicKey !== 'string') {
      return c.json({ error: 'Missing or invalid publicKey (Hex-encoded Ed25519 public key required)' }, 400);
    }

    const agentId = await deriveAgentId(publicKey);
    const norm = normalizeDisplayName(name, `Agent-${agentId.slice(6, 12)}`);
    if (!norm.ok) return c.json({ error: `Invalid display name: ${norm.error}` }, 400);
    const agentName = norm.name;
    const nameKey = norm.key;
    const now = Date.now();

    // (#30) create-open, update-gated: changing an existing registration
    // requires proof-of-possession over register|agentId|timestamp.
    let proofValid = false;
    if (proofSignature && timestamp) {
      const tsNum = Number(timestamp);
      if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 5 * 60 * 1000) return c.json({ error: 'Registration proof timestamp outside the allowed window' }, 403);
      try {
        const pubKey = await crypto.subtle.importKey('raw', Uint8Array.from((publicKey.toLowerCase().match(/../g) || []).map((h: string) => parseInt(h, 16))), { name: 'Ed25519' }, false, ['verify']);
        const sigBytes = Uint8Array.from((String(proofSignature).match(/../g) || []).map((h: string) => parseInt(h, 16)));
        proofValid = await crypto.subtle.verify('Ed25519', pubKey, sigBytes, new TextEncoder().encode(`register|${agentId}|${timestamp}`));
      } catch { proofValid = false; }
      if (!proofValid) return c.json({ error: 'Invalid registration proof signature' }, 403);
    }
    const existingAgent = await c.env.DB.prepare('SELECT * FROM agents WHERE agent_id = ?').bind(agentId).first<any>();
    if (existingAgent && !proofValid) {
      await c.env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE agent_id = ?').bind(now, agentId).run();
      return c.json({
        success: true,
        alreadyRegistered: true,
        agent: {
          agentId: existingAgent.agent_id,
          name: existingAgent.name,
          publicKey: existingAgent.public_key,
          x25519PublicKey: existingAgent.x25519_public_key || undefined,
          capabilities: JSON.parse(existingAgent.capabilities_json || '[]'),
          metadata: JSON.parse(existingAgent.metadata_json || '{}'),
          registeredAt: existingAgent.registered_at,
          lastSeenAt: now,
        },
      });
    }

    // (#28) first-claim unique display names (case-insensitive); identity stays the key

    const nameOwner = await c.env.DB.prepare('SELECT agent_id FROM agents WHERE name_key = ? AND agent_id != ?').bind(nameKey, agentId).first<{ agent_id: string }>();

    if (nameOwner) return c.json({ error: `Display name '${agentName}' is already claimed by another agent`, claimedBy: nameOwner.agent_id }, 409);

    try {

      await c.env.DB.prepare(`
        INSERT INTO agents (
          agent_id, name, name_key, public_key, x25519_public_key, capabilities_json, metadata_json, registered_at, last_seen_at, endpoint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          name_key = excluded.name_key,
          name = excluded.name,
          x25519_public_key = COALESCE(excluded.x25519_public_key, agents.x25519_public_key),
          capabilities_json = excluded.capabilities_json,
          metadata_json = excluded.metadata_json,
          last_seen_at = excluded.last_seen_at,
          endpoint = COALESCE(excluded.endpoint, agents.endpoint)
      `).bind(
        agentId,
        agentName,
        nameKey,
        publicKey.toLowerCase(),
        x25519PublicKey ? x25519PublicKey.toLowerCase() : null,
        JSON.stringify(capabilities),
        JSON.stringify(metadata),
        now,
        now,
        endpoint || null
      ).run();

    } catch (e: any) {

      // (#28) concurrent claim of the same name: the unique index wins the race; report it as a claim, not a crash

      if (String(e?.message || e).includes('UNIQUE')) return c.json({ error: `Display name '${agentName}' is already claimed by another agent` }, 409);

      throw e;

    }

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
 * Polls (RFC 0001): record access for the pure tally (D1)
 */
const d1RowToEnvelope = (r: any) => ({
  id: r.id, channel: r.channel, sender: r.sender, type: r.type, sequence: r.sequence,
  storedSeq: r.stored_seq ?? r.sequence, timestamp: r.timestamp, payload: JSON.parse(r.payload_json),
  signature: r.signature, checksum: r.checksum, replyToId: r.reply_to_id || undefined, encrypted: r.encrypted === 1,
});
function d1PollStore(DB: D1Database): PollStore {
  return {
    async getPoll(channel, pollId) {
      const r = await DB.prepare("SELECT * FROM messages WHERE channel = ? AND id = ? AND type = 'poll'").bind(channel, pollId).first<any>();
      return r ? d1RowToEnvelope(r) : null;
    },
    async candidates(channel, pollId) {
      const rows = await DB.prepare("SELECT * FROM messages WHERE channel = ? AND type IN ('vote','poll') AND instr(payload_json, ?) > 0 ORDER BY COALESCE(stored_seq, sequence) ASC").bind(channel, `"pollId":"${pollId}"`).all();
      return (rows.results || []).map(d1RowToEnvelope);
    },
    async listPolls(channel, limit = 50) {
      const rows = channel
        ? await DB.prepare(`SELECT * FROM messages WHERE type = 'poll' AND instr(payload_json, '"kind":"open"') > 0 AND channel = ? ORDER BY COALESCE(stored_seq, sequence) DESC LIMIT ?`).bind(channel, limit).all()
        : await DB.prepare(`SELECT * FROM messages WHERE type = 'poll' AND instr(payload_json, '"kind":"open"') > 0 ORDER BY COALESCE(stored_seq, sequence) DESC LIMIT ?`).bind(limit).all();
      return (rows.results || []).map(d1RowToEnvelope);
    },
    async publicKey(agentId) {
      const r = await DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(agentId).first<{ public_key: string }>();
      return r?.public_key ?? null;
    },
    async registeredAt(agentId) {
      const r = await DB.prepare('SELECT registered_at FROM agents WHERE agent_id = ?').bind(agentId).first<{ registered_at: number }>();
      return r?.registered_at ?? null;
    },
  };
}
registerPollRoutes(app, (c) => d1PollStore(c.env.DB));

/**
 * Messages & Real-Time Coordination
 */
app.get('/v1/channels/:name/messages', async (c) => {
  try {
    const slug = c.req.param('name').toLowerCase();
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
    // (#54) an explicit ?after= (including 0) is a paging cursor: ascending
    // from that storedSeq. Only a request WITHOUT a cursor gets the newest page.
    const afterRaw = c.req.query('after');
    const afterSeq = afterRaw === undefined ? NaN : parseInt(afterRaw, 10);
    const hasAfter = Number.isFinite(afterSeq);

    let query = 'SELECT * FROM messages WHERE channel = ?';
    const params: any[] = [slug];

    if (hasAfter) {
      query += ' AND COALESCE(stored_seq, sequence) > ? ORDER BY COALESCE(stored_seq, sequence) ASC LIMIT ?';
      params.push(afterSeq, limit);
    } else {
      query += ' ORDER BY COALESCE(stored_seq, sequence) DESC LIMIT ?';
      params.push(limit);
    }

    const rows = await c.env.DB.prepare(query).bind(...params).all();
    const messages: MessageEnvelope[] = (rows.results || []).map((r: any) => ({
      id: r.id,
      channel: r.channel,
      sender: r.sender,
      type: r.type as MessageType,
      sequence: r.sequence,
      storedSeq: r.stored_seq ?? r.sequence,
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

    // (#60) no cursor: the DESC newest page is returned oldest-first within
    // the page; an explicit cursor is already ASC and must never be reversed.
    if (!hasAfter) messages.reverse();

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
    // (RFC 0001) poll and ballot envelopes get the ingest checks on top
    const pollRefusal = await pollIngestGate(d1PollStore(c.env.DB), envelope, (c.env as any).PUBLIC_ORIGIN || new URL(c.req.url).origin);
    if (pollRefusal) return c.json(pollRefusal.body, pollRefusal.status as any);

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

    // (#29) verify-as-stored: the client-signed sequence is stored verbatim;
    // the Durable Object counter provides unsigned ingest order (storedSeq).
    if (typeof envelope.sequence !== 'number' || typeof envelope.timestamp !== 'number') {
      return c.json({ error: 'sequence and timestamp must be numbers and are part of the sign string' }, 400);
    }
    if (envelope.channel !== channelName) {
      return c.json({ error: `Envelope channel ${envelope.channel} does not match URL channel ${channelName}` }, 400);
    }
    const existingMsg = await c.env.DB.prepare('SELECT stored_seq, sequence, signature FROM messages WHERE id = ?').bind(envelope.id).first<any>();
    if (existingMsg) {
      if (existingMsg.signature === envelope.signature) {
        return c.json({ success: true, alreadyStored: true, envelope: { ...envelope, channel: channelName, storedSeq: existingMsg.stored_seq ?? existingMsg.sequence } });
      }
      return c.json({ error: 'Envelope id is already bound to a different envelope' }, 409);
    }
    const doStub = c.env.SWARM_CHANNEL.getByName(channelName);
    const storedSeq = await doStub.getNextSequence();

    // 4. Save to D1 Relational DB
    await c.env.DB.prepare(`
      INSERT INTO messages (
        id, channel, sender, type, sequence, stored_seq, timestamp, payload_json, signature, checksum, reply_to_id, encrypted, recipient_keys_json, ephemeral_public_key, nonce
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      envelope.id,
      channelName,
      envelope.sender,
      envelope.type,
      envelope.sequence,
      storedSeq,
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

    return c.json({ success: true, envelope: { ...envelope, storedSeq } });
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
  // forward the raw upgrade to the DO's fetch(): a 101 Response cannot cross RPC
  const doUrl = new URL(c.req.url);
  doUrl.searchParams.set('channel', channelName);
  if (agentId) doUrl.searchParams.set('agent', agentId);
  return doStub.fetch(new Request(doUrl.toString(), c.req.raw));
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
    const { creatorId, title, description, requiredCapabilities = [], timeoutMs = 3600000, reward, signature, timestamp } = body;

    if (!creatorId || !title || !description) {
      return c.json({ error: 'creatorId, title, and description are required' }, 400);
    }
    // (#30) prove the creator's key; the signature binds the task content
    const creator = await c.env.DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(creatorId).first<{ public_key: string }>();
    if (!creator) return c.json({ error: `creatorId ${creatorId} is not registered` }, 401);
    if (!signature || timestamp === undefined) return c.json({ error: 'signature and timestamp required: sign task|create|-|<creatorId>|<timestamp>|<sha256(canonicalJson(payload))>' }, 401);
    const createCheck = await verifyTaskAction({ action: 'create', taskId: '-', agentId: creatorId, timestamp: Number(timestamp), payload: { title, description, requiredCapabilities, timeoutMs, reward: reward ?? null }, signature }, creator.public_key);
    if (!createCheck.valid) return c.json({ error: createCheck.error }, 403);

    // (#71) id derived from the creator's proof: a replayed create maps to the same task
    const taskId = `task_${(await sha256Hex(signature)).slice(0, 16)}`;
    if (await c.env.DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(taskId).first()) return c.json({ success: true, alreadyCreated: true, task: { id: taskId } });
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
    const { agentId, signature, timestamp } = await c.req.json();

    if (!agentId) {
      return c.json({ error: 'agentId required' }, 400);
    }
    const claimer = await c.env.DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(agentId).first<{ public_key: string }>();
    if (!claimer) return c.json({ error: `Agent ${agentId} is not registered` }, 401);
    if (!signature || timestamp === undefined) return c.json({ error: 'signature and timestamp required: sign task|claim|<taskId>|<agentId>|<timestamp>|<sha256(canonicalJson({}))>' }, 401);
    const claimCheck = await verifyTaskAction({ action: 'claim', taskId, agentId, timestamp: Number(timestamp), payload: {}, signature }, claimer.public_key);
    if (!claimCheck.valid) return c.json({ error: claimCheck.error }, 403);

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
    const { agentId, resultPayload, signature, timestamp } = await c.req.json();

    if (!agentId || !resultPayload) {
      return c.json({ error: 'agentId and resultPayload required' }, 400);
    }
    const submitter = await c.env.DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(agentId).first<{ public_key: string }>();
    if (!submitter) return c.json({ error: `Agent ${agentId} is not registered` }, 401);
    if (!signature || timestamp === undefined) return c.json({ error: 'signature and timestamp required: sign task|submit|<taskId>|<agentId>|<timestamp>|<sha256(canonicalJson({resultPayload}))>' }, 401);
    const submitCheck = await verifyTaskAction({ action: 'submit', taskId, agentId, timestamp: Number(timestamp), payload: { resultPayload }, signature }, submitter.public_key);
    if (!submitCheck.valid) return c.json({ error: submitCheck.error }, 403);

    const now = Date.now();
    const res = await c.env.DB.prepare(`
      UPDATE tasks SET status = 'completed', result_payload_json = ?, updated_at = ?
      WHERE id = ? AND claimed_by = ? AND status = 'claimed'
    `).bind(JSON.stringify(resultPayload), now, taskId, agentId).run();

    if (res.meta.changes === 0) {
      // (#71) first completion seals the result
      const cur = await c.env.DB.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').bind(taskId).first<{ status: string; claimed_by: string }>();
      if (cur && cur.claimed_by === agentId && cur.status === 'completed') return c.json({ error: 'Task result is already sealed; completed results are immutable' }, 409);
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
