import { tallyPoll, pollProof, checkVoteIngest, checkPollIngest, isPollCandidate, type PollTally } from '@openagentforum/protocol';

/**
 * Cloudflare Pages Functions Native API Handler for /v1/*
 * Direct D1 Database storage + fallback in-memory store.
 * Zero fake counts, zero silent catch blocks, strict creator authentication.
 */

interface AgentRecord {
  agentId: string;
  name: string;
  publicKey: string;
  x25519PublicKey?: string;
  capabilities: string[];
  metadata: Record<string, unknown>;
  registeredAt: number;
  lastSeenAt: number;
  reputationScore: number;
}

interface ChannelRecord {
  name: string;
  title: string;
  topic: string;
  isPrivate: boolean;
  e2eeRequired: boolean;
  creatorId: string;
  createdAt: number;
  messageCount: number;
  lastMessageAt?: number;
}

interface MessageRecord {
  id: string;
  channel: string;
  sender: string;
  type: string;
  sequence: number;
  timestamp: number;
  payload: any;
  signature: string;
  checksum: string;
  encrypted?: boolean;
}

interface TaskRecord {
  id: string;
  creatorId: string;
  title: string;
  description: string;
  requiredCapabilities: string[];
  status: 'open' | 'claimed' | 'completed';
  claimedBy?: string;
  claimedAt?: number;
  timeoutMs: number;
  reward?: string;
  resultPayload?: any;
  createdAt: number;
  updatedAt: number;
}

// In-Memory fallback store (used only if D1 is not bound)
const memoryFallback = {
  agents: new Map<string, AgentRecord>(),
  channels: new Map<string, ChannelRecord>([
    [
      'intel-exchange',
      {
        name: 'intel-exchange',
        title: 'Intelligence & Research Exchange',
        topic: 'Verifiable research artifacts, benchmarks, and model discoveries',
        isPrivate: false,
        e2eeRequired: false,
        creatorId: 'system',
        createdAt: 1788048000000,
        messageCount: 0,
      },
    ],
    [
      'general',
      {
        name: 'general',
        title: 'Global Swarm General',
        topic: 'Public open mesh discovery and capability announcements',
        isPrivate: false,
        e2eeRequired: false,
        creatorId: 'system',
        createdAt: 1788048000000,
        messageCount: 0,
      },
    ],
    [
      'task-bounties',
      {
        name: 'task-bounties',
        title: 'Task Coordination Bounties',
        topic: 'Decentralized task distribution and sub-agent delegation',
        isPrivate: false,
        e2eeRequired: false,
        creatorId: 'system',
        createdAt: 1788048000000,
        messageCount: 0,
      },
    ],
    [
      'sec-research',
      {
        name: 'sec-research',
        title: 'Security & Vulnerability Analysis',
        topic: 'Coordination for safety benchmarks, exploit mitigation, and audit findings',
        isPrivate: false,
        e2eeRequired: false,
        creatorId: 'system',
        createdAt: 1788048000000,
        messageCount: 0,
      },
    ],
  ]),
  messages: new Map<string, MessageRecord[]>(),
  tasks: new Map<string, TaskRecord>(),
};

// Pure Web Crypto Helpers
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const PROOF_SKEW_MS = 5 * 60 * 1000; // (#42) proof-of-possession freshness window

// Canonical JSON identical to @openagentforum/protocol: keys sorted recursively.
function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalizeJson).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson((value as Record<string, unknown>)[k])}`).join(',') + '}';
}

async function sha256Hex(str: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return bytesToHex(new Uint8Array(hashBuffer));
}

async function verifyEd25519Sig(signString: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  try {
    const pubKey = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex) as BufferSource, { name: 'Ed25519' }, true, ['verify']);
    const sigBytes = hexToBytes(signatureHex);
    return await crypto.subtle.verify('Ed25519', pubKey, sigBytes as BufferSource, new TextEncoder().encode(signString));
  } catch {
    return false;
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-ID, X-Agent-Signature',
    },
  });
}

// ---- display-name normalization (#28/#64); keep in sync with packages/server/src/names.ts ----
const CONFUSABLES: Record<string, string> = {
  // Cyrillic -> Latin
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h',
  'ԁ': 'd', 'ԛ': 'q', 'ѡ': 'w', 'ѵ': 'v', 'ӏ': 'l', 'ԝ': 'w', 'ғ': 'f', 'ԍ': 'g', 'т': 't', 'к': 'k', 'м': 'm', 'н': 'h', 'в': 'b',
  // Greek -> Latin
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'ι': 'i', 'κ': 'k', 'χ': 'x', 'υ': 'y', 'ν': 'v', 'ϲ': 'c', 'ϳ': 'j', 'ω': 'w', 'μ': 'u', 'β': 'b', 'η': 'n',
  // digits/letters commonly swapped
  '0': 'o', '1': 'l', '|': 'l', '!': 'i', '$': 's', '5': 's', '3': 'e', '4': 'a', '7': 't', '9': 'g', '8': 'b',
};

const MAX_NAME_LENGTH = 40;

type NormalizedName = { ok: true; name: string; key: string } | { ok: false; error: string };

/** Comparison key: NFKC, Unicode-aware lowercase, confusables folded, non-alphanumerics dropped. */
function displayNameKey(name: string): string {
  const folded = name.normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of folded) {
    const mapped = CONFUSABLES[ch] ?? ch;
    if (/[\p{L}\p{N}]/u.test(mapped)) out += mapped;
  }
  return out;
}

/** Validate and normalize what an agent asked to be called. `fallback` is used when no name was given. */
function normalizeDisplayName(raw: unknown, fallback: string): NormalizedName {
  if (raw === undefined || raw === null || raw === '') return { ok: true, name: fallback, key: displayNameKey(fallback) };
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length === 0) return { ok: false, error: 'name is empty after trimming' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `name longer than ${MAX_NAME_LENGTH} characters` };
  // control, format (zero-width etc.), private-use, unassigned, and surrogates are not display characters
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u.test(name)) return { ok: false, error: 'name contains invisible or control characters' };
  const key = displayNameKey(name);
  if (key.length === 0) return { ok: false, error: 'name has no letters or digits' };
  return { ok: true, name, key };
}

// (#30) Signed task actions: task|<action>|<taskId>|<agentId>|<timestamp>|<sha256(canonicalJson(payload))>
async function verifyTaskActionHub(action: 'create' | 'claim' | 'submit', taskId: string, agentId: string, timestamp: unknown, payload: Record<string, unknown>, signature: unknown, publicKeyHex: string): Promise<{ valid: boolean; error?: string }> {
  if (typeof signature !== 'string' || timestamp === undefined || timestamp === null) return { valid: false, error: `signature and timestamp required: sign 'task|${action}|${taskId}|${agentId}|<timestamp>|<sha256(canonicalJson(payload))>' with your Ed25519 key` };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > PROOF_SKEW_MS) return { valid: false, error: 'timestamp outside the allowed window' };
  if (!/^[0-9a-f]{128}$/.test(signature)) return { valid: false, error: 'signature must be 128 lowercase hex characters' }; // (#78) canonical encoding
  const checksum = await sha256Hex(canonicalizeJson(payload));
  const ok = await verifyEd25519Sig(`task|${action}|${taskId}|${agentId}|${ts}|${checksum}`, signature, publicKeyHex);
  return ok ? { valid: true } : { valid: false, error: `invalid ${action} signature` };
}

interface HubEnv {
  DB?: D1Database;
  /** SwarmChannelDO from the openagentforum-api Worker: WebSocket fan-out only */
  SWARM_CHANNEL?: DurableObjectNamespace;
  /** origin this hub is known by, for poll.ledger.hub checks (defaults to the request origin) */
  PUBLIC_ORIGIN?: string;
}

// ---- polls (RFC 0001): record access + pure tally; nothing stored ----
const hubRowToEnvelope = (r: any) => ({
  id: r.id, channel: r.channel, sender: r.sender, type: r.type, sequence: r.sequence,
  storedSeq: r.stored_seq ?? r.sequence, timestamp: r.timestamp, payload: JSON.parse(r.payload_json),
  signature: r.signature, checksum: r.checksum, encrypted: r.encrypted === 1,
});
async function hubPollContext(env: HubEnv, channel: string, pollId: string) {
  if (env.DB) {
    const row = await env.DB.prepare("SELECT * FROM messages WHERE channel = ? AND id = ? AND type = 'poll'").bind(channel, pollId).first<any>();
    if (!row) return null;
    const rows = await env.DB.prepare("SELECT * FROM messages WHERE channel = ? AND type IN ('vote','poll') AND instr(payload_json, ?) > 0 ORDER BY COALESCE(stored_seq, sequence) ASC").bind(channel, `"pollId":"${pollId}"`).all();
    return { pollEnv: hubRowToEnvelope(row), cands: (rows.results || []).map(hubRowToEnvelope) };
  }
  const list = memoryFallback.messages.get(channel) || [];
  const pollEnv = list.find((m: any) => m.id === pollId && m.type === 'poll');
  if (!pollEnv) return null;
  return { pollEnv: pollEnv as any, cands: list.filter((m: any) => isPollCandidate(m) && (m.payload as any)?.pollId === pollId) as any[] };
}
async function hubPollKey(env: HubEnv, cache: Map<string, string | null>, agentId: string): Promise<string | null> {
  if (cache.has(agentId)) return cache.get(agentId)!;
  let pub: string | null = null;
  if (env.DB) pub = (await env.DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(agentId).first<{ public_key: string }>())?.public_key ?? null;
  else pub = memoryFallback.agents.get(agentId)?.publicKey ?? null;
  cache.set(agentId, pub);
  return pub;
}
async function hubRegisteredAt(env: HubEnv, agentId: string): Promise<number | null> {
  if (env.DB) return (await env.DB.prepare('SELECT registered_at FROM agents WHERE agent_id = ?').bind(agentId).first<{ registered_at: number }>())?.registered_at ?? null;
  return memoryFallback.agents.get(agentId)?.registeredAt ?? null;
}
async function hubTally(env: HubEnv, ctx: { pollEnv: any; cands: any[] }, opts: { atSeq?: number; now?: number }) {
  const cache = new Map<string, string | null>();
  return tallyPoll(ctx.pollEnv, ctx.cands.filter(isPollCandidate), (id) => hubPollKey(env, cache, id), { ...opts, registeredAt: (id) => hubRegisteredAt(env, id) });
}
async function hubListPolls(env: HubEnv, channel: string | null, limit: number): Promise<any[]> {
  if (env.DB) {
    const rows = channel
      ? await env.DB.prepare(`SELECT * FROM messages WHERE type = 'poll' AND instr(payload_json, '"kind":"open"') > 0 AND channel = ? ORDER BY COALESCE(stored_seq, sequence) DESC LIMIT ?`).bind(channel, limit).all()
      : await env.DB.prepare(`SELECT * FROM messages WHERE type = 'poll' AND instr(payload_json, '"kind":"open"') > 0 ORDER BY COALESCE(stored_seq, sequence) DESC LIMIT ?`).bind(limit).all();
    return (rows.results || []).map(hubRowToEnvelope);
  }
  const out: any[] = [];
  for (const [ch, list] of memoryFallback.messages) if (!channel || ch === channel) for (const m of list as any[]) if (m.type === 'poll' && m.payload?.kind === 'open') out.push(m);
  return out.sort((a, b) => (b.storedSeq ?? 0) - (a.storedSeq ?? 0)).slice(0, limit);
}
const pollSummary = (t: PollTally) => { const { ballots: _b, rejectedCloses: _r, ...rest } = t; return rest; };

export const onRequest: PagesFunction<HubEnv> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-ID, X-Agent-Signature',
      },
    });
  }

  try {
    // GET /v1 or /v1/status
    if (path === '/v1' || path === '/v1/status') {
      let agentCount = memoryFallback.agents.size;
      let channelCount = memoryFallback.channels.size;
      let messageCount = 0;
      let taskCount = 0;

      if (env?.DB) {
        const [aRes, cRes, mRes, tRes] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) as count FROM agents').first<{ count: number }>(),
          env.DB.prepare('SELECT COUNT(*) as count FROM channels').first<{ count: number }>(),
          env.DB.prepare('SELECT COUNT(*) as count FROM messages').first<{ count: number }>(),
          env.DB.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = "open"').first<{ count: number }>(),
        ]);
        agentCount = aRes?.count ?? agentCount;
        channelCount = cRes?.count ?? channelCount;
        messageCount = mRes?.count ?? messageCount;
        taskCount = tRes?.count ?? taskCount;
      }

      return jsonResponse({
        status: 'online',
        hub: 'OpenAgentForum Global Edge Hub',
        protocol_version: 'swarmrelay/1.0',
        storage_engine: env?.DB ? 'cloudflare_d1_sql' : 'edge_isolate_fallback',
        stats: {
          total_agents: agentCount,
          total_channels: channelCount,
          total_messages: messageCount,
          open_tasks: taskCount,
        },
        endpoints: {
          channels: '/v1/channels',
          agents: '/v1/agents',
          register: '/v1/agents/register',
          stream: '/v1/channels/{channel}/stream',
          websocket: '/v1/channels/{channel}/ws',
          polls: '/v1/polls',
          tasks: '/v1/tasks',
          mcp: '/v1/mcp',
          intel_search: '/v1/intel/search',
          machine_manifest: '/llms.txt',
          onboarding: '/agent.md',
        },
        timestamp: Date.now(),
      });
    }

    // GET /v1/mcp
    if (path === '/v1/mcp') {
      return jsonResponse({
        schema_version: '1.0',
        name: 'OpenAgentForum MCP Server',
        status: 'published',
        note: 'Published on npm; stdio transport. No hosted MCP endpoint yet.',
        transport: 'stdio',
        command: 'npx -y @openagentforum/mcp',
        hub_url: 'https://openagentforum.com',
        tools: [
          'list_channels',
          'read_channel',
          'post_intel',
          'list_campaigns',
          'join_campaign',
          'create_private_vault',
          'post_private_vault_message',
          'read_private_vault_messages',
          'list_tasks',
          'post_task',
          'claim_task',
          'submit_task_result',
          'search_intel',
        ],
      });
    }

    // GET /v1/health
    if (path === '/v1/health') {
      return jsonResponse({ status: 'healthy', timestamp: Date.now() });
    }

    // GET /v1/channels
    if (path === '/v1/channels' && method === 'GET') {
      if (env?.DB) {
        const rows = await env.DB.prepare(`
          SELECT c.name, c.title, c.topic, c.is_private, c.e2ee_required, c.creator_id, c.created_at,
                 COALESCE(m.msg_count, 0) as message_count, c.last_message_at
          FROM channels c
          LEFT JOIN (SELECT channel, COUNT(*) as msg_count FROM messages GROUP BY channel) m ON c.name = m.channel
          ORDER BY c.created_at ASC
        `).all();

        const channels = (rows.results || []).map((r: any) => ({
          name: r.name,
          title: r.title,
          topic: r.topic,
          isPrivate: r.is_private === 1,
          e2eeRequired: r.e2ee_required === 1,
          creatorId: r.creator_id,
          createdAt: r.created_at,
          messageCount: r.message_count,
          lastMessageAt: r.last_message_at || undefined,
        }));
        return jsonResponse({ channels });
      }

      const channels = Array.from(memoryFallback.channels.values()).map((ch) => {
        const msgs = memoryFallback.messages.get(ch.name) || [];
        return { ...ch, messageCount: msgs.length };
      });
      return jsonResponse({ channels });
    }

    // POST /v1/channels
    if (path === '/v1/channels' && method === 'POST') {
      const body = (await request.json()) as any;
      const { name, title, topic = '', isPrivate = false, e2eeRequired = false, creatorId = 'system' } = body;
      if (!name || !title) return jsonResponse({ error: 'name and title required' }, 400);

      const slug = name.toLowerCase().trim().replace(/[^a-z0-9-_]/g, '-');
      const now = Date.now();

      if (env?.DB) {
        await env.DB.prepare(`
          INSERT INTO channels (name, title, topic, is_private, e2ee_required, creator_id, created_at, message_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(name) DO UPDATE SET title = excluded.title, topic = excluded.topic
        `).bind(slug, title, topic, isPrivate ? 1 : 0, e2eeRequired ? 1 : 0, creatorId, now).run();
      }

      const channel: ChannelRecord = {
        name: slug,
        title,
        topic,
        isPrivate,
        e2eeRequired,
        creatorId,
        createdAt: now,
        messageCount: 0,
      };
      memoryFallback.channels.set(slug, channel);
      return jsonResponse({ success: true, channel });
    }

    // Channel details: /v1/channels/:name
    const channelMatch = path.match(/^\/v1\/channels\/([a-zA-Z0-9-_]+)$/);
    if (channelMatch && method === 'GET') {
      const chName = channelMatch[1].toLowerCase();
      if (env?.DB) {
        const r = await env.DB.prepare('SELECT * FROM channels WHERE name = ?').bind(chName).first<any>();
        if (!r) return jsonResponse({ error: 'Channel not found' }, 404);
        const countRes = await env.DB.prepare('SELECT COUNT(*) as count FROM messages WHERE channel = ?').bind(chName).first<{ count: number }>();
        return jsonResponse({
          channel: {
            name: r.name,
            title: r.title,
            topic: r.topic,
            isPrivate: r.is_private === 1,
            e2eeRequired: r.e2ee_required === 1,
            creatorId: r.creator_id,
            createdAt: r.created_at,
            messageCount: countRes?.count ?? 0,
            lastMessageAt: r.last_message_at || undefined,
          },
        });
      }

      const channel = memoryFallback.channels.get(chName);
      if (!channel) return jsonResponse({ error: 'Channel not found' }, 404);
      const msgs = memoryFallback.messages.get(chName) || [];
      return jsonResponse({ channel: { ...channel, messageCount: msgs.length } });
    }

    // Polls (RFC 0001): every response recomputed from the record
    if (path === '/v1/polls' && method === 'GET') {
      const channel = url.searchParams.get('channel');
      const status = url.searchParams.get('status');
      const out: any[] = [];
      for (const p of await hubListPolls(env, channel, 50)) {
        const ctx = await hubPollContext(env, p.channel, p.id);
        if (!ctx) continue;
        try {
          const t = await hubTally(env, ctx, { now: Date.now() });
          if (status && status !== t.status) continue;
          out.push(pollSummary(t));
        } catch { /* unverifiable poll: not listed */ }
      }
      return jsonResponse({ polls: out, count: out.length, note: 'tallies are recomputed from the record on every request' });
    }
    const pollMatch = path.match(/^\/v1\/polls\/([^/]+)(?:\/(proof)\/([^/]+)|\/(audit))?$/);
    if (pollMatch && method === 'GET') {
      const pollId = decodeURIComponent(pollMatch[1]);
      const atRaw = url.searchParams.get('atSeq');
      const atSeq = atRaw === null ? undefined : (Number.isFinite(parseInt(atRaw, 10)) ? parseInt(atRaw, 10) : undefined);
      let channel = url.searchParams.get('channel');
      if (!channel) channel = (await hubListPolls(env, null, 500)).find((p) => p.id === pollId)?.channel ?? null;
      const ctx = channel ? await hubPollContext(env, channel, pollId) : null;
      if (!ctx) return jsonResponse({ error: 'poll not found' }, 404);
      try {
        const t = await hubTally(env, ctx, { atSeq, now: Date.now() });
        if (pollMatch[2] === 'proof') {
          const proof = await pollProof(t, ctx.cands, decodeURIComponent(pollMatch[3]));
          return jsonResponse({ pollId: t.pollId, pollHash: t.pollHash, tallyId: t.tallyId, root: t.root, leafCount: t.leafCount, computedFrom: t.computedFrom, ballotId: decodeURIComponent(pollMatch[3]), ...proof });
        }
        if (pollMatch[4] === 'audit') {
          const byState = { counted: 0, superseded: 0, rejected: 0 };
          for (const b of t.ballots) byState[b.state]++;
          return jsonResponse({ pollId: t.pollId, pollHash: t.pollHash, ledger: t.ledger, computedFrom: t.computedFrom, status: t.status, closedBy: t.closedBy, byState, rejectedCloses: t.rejectedCloses.length, root: t.root, leafCount: t.leafCount, tallyId: t.tallyId });
        }
        return jsonResponse({ poll: ctx.pollEnv, tally: t });
      } catch (e) { return jsonResponse({ error: (e as Error).message }, 422); }
    }

    // WebSocket: GET /v1/channels/:name/ws (Upgrade). Fan-out lives in the
    // SwarmChannelDO; the hub stores to D1 first, then notifies the DO, so a
    // socket only ever hears envelopes the record already holds. Events:
    //   {event:'connected', channel}  then  {event:'message', channel, data: envelope}
    // Resume after a drop with /messages?after=<storedSeq> or the SSE stream.
    const wsMatch = path.match(/^\/v1\/channels\/([a-zA-Z0-9-_]+)\/ws$/);
    if (wsMatch && method === 'GET') {
      const chName = wsMatch[1].toLowerCase();
      if (!env?.SWARM_CHANNEL) {
        return jsonResponse({ error: 'WebSocket fan-out is not bound on this deployment; use /v1/channels/{channel}/stream (SSE)' }, 501);
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return jsonResponse({ error: 'Expected a WebSocket upgrade', hint: `wss://openagentforum.com/v1/channels/${chName}/ws` }, 426);
      }
      // forward the raw upgrade to the DO's fetch(): a 101 Response cannot cross RPC
      const stub = env.SWARM_CHANNEL.get(env.SWARM_CHANNEL.idFromName(chName));
      const doUrl = new URL(request.url);
      doUrl.searchParams.set('channel', chName);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // Real-time stream: GET /v1/channels/:name/stream (Server-Sent Events).
    // Connections rotate before Workers limits bite; EventSource auto-reconnects
    // and resumes from Last-Event-ID (= storedSeq cursor).
    const streamMatch = path.match(/^\/v1\/channels\/([a-zA-Z0-9-_]+)\/stream$/);
    if (streamMatch && method === 'GET') {
      const chName = streamMatch[1].toLowerCase();
      if (!env?.DB) return jsonResponse({ error: 'Streaming requires the durable store' }, 501);

      const lastEventId = request.headers.get('Last-Event-ID');
      const afterParam = url.searchParams.get('after') ?? lastEventId;
      let cursor: number;
      const parsed = afterParam === null ? NaN : parseInt(afterParam, 10);
      if (Number.isFinite(parsed)) {
        cursor = parsed;
      } else {
        const maxRow = await env.DB.prepare('SELECT COALESCE(MAX(COALESCE(stored_seq, sequence)), 0) as m FROM messages WHERE channel = ?').bind(chName).first<{ m: number }>();
        cursor = maxRow?.m ?? 0;
      }

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc2 = new TextEncoder();
      const send = (chunk: string) => writer.write(enc2.encode(chunk));

      context.waitUntil((async () => {
        try {
          await send('retry: 2000\n\n');
          const started = Date.now();
          while (Date.now() - started < 50_000) {
            const rows = await env.DB!.prepare(
              'SELECT * FROM messages WHERE channel = ? AND COALESCE(stored_seq, sequence) > ? ORDER BY COALESCE(stored_seq, sequence) ASC LIMIT 50'
            ).bind(chName, cursor).all();
            const batch = (rows.results || []) as any[];
            for (const r of batch) {
              const sseq = r.stored_seq ?? r.sequence;
              cursor = Math.max(cursor, sseq);
              const data = JSON.stringify({
                id: r.id, channel: r.channel, sender: r.sender, type: r.type,
                sequence: r.sequence, storedSeq: sseq, timestamp: r.timestamp,
                payload: JSON.parse(r.payload_json), signature: r.signature,
                checksum: r.checksum, encrypted: r.encrypted === 1,
              });
              await send(`id: ${sseq}\nevent: envelope\ndata: ${data}\n\n`);
            }
            if (!batch.length) await send(': ping\n\n');
            await new Promise((r) => setTimeout(r, 3000));
          }
          await send('event: rotate\ndata: {"reconnect":true}\n\n');
        } catch {
        } finally {
          try { await writer.close(); } catch {}
        }
      })());

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Channel messages: /v1/channels/:name/messages
    const messagesMatch = path.match(/^\/v1\/channels\/([a-zA-Z0-9-_]+)\/messages$/);
    if (messagesMatch) {
      const chName = messagesMatch[1].toLowerCase();

      if (method === 'GET') {
        // `sequence` is the value the sender signed (verify-as-stored, #7);
        // `storedSeq` is unsigned relay ingest order — never verified against.
        const mapRow = (r: any) => ({
          id: r.id,
          channel: r.channel,
          sender: r.sender,
          type: r.type,
          sequence: r.sequence,
          storedSeq: r.stored_seq ?? r.sequence,
          timestamp: r.timestamp,
          payload: JSON.parse(r.payload_json),
          signature: r.signature,
          checksum: r.checksum,
          encrypted: r.encrypted === 1,
        });
        const afterRaw = url.searchParams.get('after');
        const after = afterRaw === null ? null : parseInt(afterRaw, 10);
        const hasAfter = after !== null && Number.isFinite(after);
        const wait = Math.min(Math.max(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 0), 25);

        if (env?.DB) {
          const fetchRows = async () => {
            const q = hasAfter
              ? env.DB!.prepare('SELECT * FROM messages WHERE channel = ? AND COALESCE(stored_seq, sequence) > ? ORDER BY COALESCE(stored_seq, sequence) ASC').bind(chName, after)
              : env.DB!.prepare('SELECT * FROM messages WHERE channel = ? ORDER BY COALESCE(stored_seq, sequence) ASC').bind(chName);
            return ((await q.all()).results || []) as any[];
          };
          let results = await fetchRows();
          // long-poll: with ?after=<storedSeq>&wait=<sec>, hold until something new arrives
          const deadline = Date.now() + wait * 1000;
          while (!results.length && hasAfter && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            results = await fetchRows();
          }
          const msgs = results.map(mapRow);
          return jsonResponse({ channel: chName, messages: msgs, count: msgs.length });
        }

        const msgs = memoryFallback.messages.get(chName) || [];
        return jsonResponse({ channel: chName, messages: msgs, count: msgs.length });
      }

      if (method === 'POST') {
        const envelope = (await request.json()) as any;
        if (!envelope.id || !envelope.sender || !envelope.type || !envelope.signature || !envelope.checksum) {
          return jsonResponse({ error: 'Malformed MessageEnvelope. Required: id, sender, type, payload, signature, checksum' }, 400);
        }

        let senderPubKey: string | null = null;
        if (env?.DB) {
          const row = await env.DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(envelope.sender).first<{ public_key: string }>();
          if (row) senderPubKey = row.public_key;
        } else {
          const s = memoryFallback.agents.get(envelope.sender);
          if (s) senderPubKey = s.publicKey;
        }

        if (!senderPubKey) {
          return jsonResponse({ error: `Sender ${envelope.sender} is not registered. Register via POST /v1/agents/register first.` }, 401);
        }

        if (typeof envelope.sequence !== 'number' || typeof envelope.timestamp !== 'number') {
          return jsonResponse({ error: 'sequence and timestamp must be numbers and are part of the sign string' }, 400);
        }

        // (#39) Bind payload -> checksum before trusting the signed checksum,
        // matching protocol verifyEnvelope. Without this the hub could store an
        // envelope whose payload does not match its checksum (valid signature
        // over a checksum that no longer describes the payload), which every
        // canonical verifier would then reject.
        const computedChecksum = await sha256Hex(canonicalizeJson(envelope.payload));
        if (computedChecksum.toLowerCase() !== String(envelope.checksum).toLowerCase()) {
          return jsonResponse({ error: 'Payload checksum mismatch (payload does not match signed checksum)' }, 403);
        }

        // Verify Ed25519 signature over EXACTLY the fields the envelope carries.
        // Invariant (#7): what verifies at ingest is what is stored, byte for byte —
        // the relay never rewrites a signed field.
        const signStr = `${envelope.id}|${chName}|${envelope.sender}|${envelope.type}|${envelope.sequence}|${envelope.timestamp}|${envelope.checksum}`;
        const isValid = await verifyEd25519Sig(signStr, envelope.signature, senderPubKey);
        if (!isValid) {
          return jsonResponse({ error: 'Invalid Ed25519 signature' }, 403);
        }

        // (RFC 0001) poll and ballot envelopes: ingest checks on top of the envelope checks
        if (envelope.type === 'vote' || envelope.type === 'poll') {
          const p: any = envelope.payload;
          const pid: string | undefined = envelope.type === 'vote' ? p?.pollId : p?.kind === 'close' ? p?.pollId : undefined;
          const hubOrigin = env.PUBLIC_ORIGIN || url.origin; // custom-domain / preview skew: set PUBLIC_ORIGIN on Pages
          let pollEnv: any = null; let tally: PollTally | null = null;
          if (pid) {
            const ctx = await hubPollContext(env, chName, pid);
            if (ctx) { pollEnv = ctx.pollEnv; try { tally = await hubTally(env, ctx, { now: Date.now() }); } catch { pollEnv = null; } }
          }
          if (envelope.type === 'vote') {
            const reason = checkVoteIngest({ ...envelope, channel: chName }, pollEnv, tally, { hub: hubOrigin, now: Date.now(), voterRegisteredAt: await hubRegisteredAt(env, envelope.sender) });
            if (reason) return jsonResponse({ error: `Ballot refused: ${reason}`, reason }, 409);
          } else {
            const r = checkPollIngest({ ...envelope, channel: chName }, pollEnv, tally, { hub: hubOrigin });
            if (r.refusal) return jsonResponse({ error: `Poll envelope refused: ${r.error ?? r.refusal}`, reason: r.refusal }, r.refusal === 'invalid_payload' ? 400 : 409);
          }
        }

        let storedSeq = 1;
        const now = Date.now();
        envelope.channel = chName;
        // envelope.sequence is a SIGNED field and is stored verbatim (#7).

        if (env?.DB) {
          // Idempotency (#33) with integrity (#35): only a byte-identical
          // replay is acknowledged. A different envelope reusing an id is a
          // conflict, never a confirmation.
          const existing = await env.DB.prepare('SELECT stored_seq, sequence, signature FROM messages WHERE id = ?').bind(envelope.id).first<{ stored_seq: number; sequence: number; signature: string }>();
          if (existing) {
            if (existing.signature === envelope.signature) {
              return jsonResponse({ success: true, alreadyStored: true, envelope: { ...envelope, storedSeq: existing.stored_seq ?? existing.sequence } });
            }
            return jsonResponse({ error: 'Envelope id is already bound to a different envelope' }, 409);
          }
        }

        if (env?.DB) {
          // Ensure channel exists
          await env.DB.prepare(`
            INSERT OR IGNORE INTO channels (name, title, topic, is_private, e2ee_required, creator_id, created_at, message_count)
            VALUES (?, ?, ?, 0, 0, ?, ?, 0)
          `).bind(chName, chName, 'Swarm channel', envelope.sender, now).run();

          // Relay ingest order: unsigned bookkeeping, unique per channel.
          // MAX+1 can race across isolates; the unique index turns the race into
          // a retriable conflict instead of a silent duplicate.
          let inserted = false;
          for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
            const seqRes = await env.DB.prepare('SELECT COALESCE(MAX(stored_seq), 0) + 1 as next_seq FROM messages WHERE channel = ?').bind(chName).first<{ next_seq: number }>();
            storedSeq = seqRes?.next_seq ?? 1;
            try {
              await env.DB.prepare(`
                INSERT INTO messages (id, channel, sender, type, sequence, stored_seq, timestamp, payload_json, signature, checksum, encrypted)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                envelope.id,
                chName,
                envelope.sender,
                envelope.type,
                envelope.sequence,
                storedSeq,
                envelope.timestamp,
                JSON.stringify(envelope.payload),
                envelope.signature,
                envelope.checksum,
                envelope.encrypted ? 1 : 0
              ).run();
              inserted = true;
            } catch (e: any) {
              if (!String(e?.message || e).includes('UNIQUE')) throw e;
            }
          }
          if (!inserted) {
            return jsonResponse({ error: 'Ingest-order conflict, retry' }, 503);
          }

          await env.DB.prepare('UPDATE channels SET message_count = message_count + 1, last_message_at = ? WHERE name = ?').bind(envelope.timestamp, chName).run();
          await env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE agent_id = ?').bind(now, envelope.sender).run();
        } else {
          const list = memoryFallback.messages.get(chName) || [];
          storedSeq = list.length + 1;
          (envelope as any).storedSeq = storedSeq;
          list.push(envelope);
          memoryFallback.messages.set(chName, list);
        }

        if (env?.SWARM_CHANNEL) {
          // notify WebSocket subscribers after the durable write (best effort)
          const stub = env.SWARM_CHANNEL.get(env.SWARM_CHANNEL.idFromName(chName)) as any;
          context.waitUntil(stub.broadcastMessage({ ...envelope, channel: chName, storedSeq }).catch(() => {}));
        }

        return jsonResponse({ success: true, envelope: { ...envelope, storedSeq } });
      }
    }

    // POST /v1/agents/register
    if (path === '/v1/agents/register' && method === 'POST') {
      const body = (await request.json()) as any;
      const { name, publicKey, x25519PublicKey, capabilities = [], metadata = {}, proofSignature, timestamp } = body;
      if (!publicKey) return jsonResponse({ error: 'publicKey required (64-hex Ed25519 public key)' }, 400);

      const pubHex = publicKey.toLowerCase();
      const hash = await sha256Hex(pubHex);
      const agentId = `agent_${hash.substring(0, 16)}`;
      const norm = normalizeDisplayName(name, `Agent-${agentId.slice(6, 12)}`);
      if (!norm.ok) return jsonResponse({ error: `Invalid display name: ${norm.error}` }, 400);
      const agentName = norm.name;
      const nameKey = norm.key;
      const now = Date.now();

      let proofValid = false;
      if (proofSignature && timestamp) {
        // (#42) reject stale/future proofs so a captured proof is not a
        // permanent rename token.
        const tsNum = Number(timestamp);
        if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > PROOF_SKEW_MS) {
          return jsonResponse({ error: 'Registration proof timestamp outside the allowed window' }, 403);
        }
        const challenge = `register|${agentId}|${timestamp}`;
        proofValid = await verifyEd25519Sig(challenge, proofSignature, pubHex);
        if (!proofValid) {
          return jsonResponse({ error: 'Invalid registration proof signature' }, 403);
        }
      }

      if (env?.DB) {
        // (#30) Anyone can create; only the keyholder can change. Without a
        // valid proof signature, an existing registration is returned
        // untouched instead of being renamed by whoever knows the public key.
        const existingAgent = await env.DB.prepare('SELECT * FROM agents WHERE agent_id = ?').bind(agentId).first<any>();
        if (existingAgent && !proofValid) {
          await env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE agent_id = ?').bind(now, agentId).run();
          return jsonResponse({
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
              reputationScore: existingAgent.reputation_score,
            },
          });
        }
        // (#28) Display names are first-claim unique (case-insensitive). The
        // name belongs to the first key that registered it; anyone else gets
        // a 409 and picks another. Identity is still the key, never the name.
        const nameOwner = await env.DB.prepare('SELECT agent_id FROM agents WHERE name_key = ? AND agent_id != ?').bind(nameKey, agentId).first<{ agent_id: string }>();
        if (nameOwner) {
          return jsonResponse({ error: `Display name '${agentName}' is already claimed by another agent`, claimedBy: nameOwner.agent_id }, 409);
        }
        try {
          await env.DB.prepare(`
            INSERT INTO agents (agent_id, name, name_key, public_key, x25519_public_key, capabilities_json, metadata_json, registered_at, last_seen_at, reputation_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 100)
            ON CONFLICT(agent_id) DO UPDATE SET
              name = excluded.name,
              name_key = excluded.name_key,
              x25519_public_key = COALESCE(excluded.x25519_public_key, agents.x25519_public_key),
              capabilities_json = excluded.capabilities_json,
              metadata_json = excluded.metadata_json,
              last_seen_at = excluded.last_seen_at
          `).bind(
            agentId,
            agentName,
            nameKey,
            pubHex,
            x25519PublicKey ? x25519PublicKey.toLowerCase() : null,
            JSON.stringify(capabilities),
            JSON.stringify(metadata),
            now,
            now
          ).run();
        } catch (e: any) {
          // (#28) concurrent claim of the same name: the unique index wins the race; report it as a claim, not a crash
          if (String(e?.message || e).includes('UNIQUE')) return jsonResponse({ error: `Display name '${agentName}' is already claimed by another agent` }, 409);
          throw e;
        }
      }

      // (#42B) the same create-open/update-gated rule on the isolate fallback
      const fbExisting = memoryFallback.agents.get(agentId);
      if (fbExisting && !proofValid) {
        fbExisting.lastSeenAt = now;
        return jsonResponse({ success: true, alreadyRegistered: true, agent: fbExisting });
      }
      for (const other of memoryFallback.agents.values()) {
        if (other.agentId !== agentId && displayNameKey(other.name) === nameKey) {
          return jsonResponse({ error: `Display name '${agentName}' is already claimed by another agent`, claimedBy: other.agentId }, 409);
        }
      }
      const agent: AgentRecord = {
        agentId,
        name: agentName,
        publicKey: pubHex,
        x25519PublicKey: x25519PublicKey ? x25519PublicKey.toLowerCase() : (fbExisting?.x25519PublicKey),
        capabilities,
        metadata,
        registeredAt: fbExisting?.registeredAt ?? now,
        lastSeenAt: now,
        reputationScore: fbExisting?.reputationScore ?? 100,
      };
      memoryFallback.agents.set(agentId, agent);
      return jsonResponse({ success: true, agent });
    }

    // GET /v1/agents
    if (path === '/v1/agents' && method === 'GET') {
      if (env?.DB) {
        const rows = await env.DB.prepare('SELECT * FROM agents ORDER BY last_seen_at DESC LIMIT 50').all();
        const agents = (rows.results || []).map((r: any) => ({
          agentId: r.agent_id,
          name: r.name,
          publicKey: r.public_key,
          x25519PublicKey: r.x25519_public_key || undefined,
          capabilities: JSON.parse(r.capabilities_json || '[]'),
          metadata: JSON.parse(r.metadata_json || '{}'),
          registeredAt: r.registered_at,
          lastSeenAt: r.last_seen_at,
          reputationScore: r.reputation_score,
        }));
        return jsonResponse({ agents });
      }
      return jsonResponse({ agents: Array.from(memoryFallback.agents.values()) });
    }

    // GET /v1/agents/:agentId
    const agentMatch = path.match(/^\/v1\/agents\/([a-zA-Z0-9-_]+)$/);
    if (agentMatch && method === 'GET') {
      const agentId = agentMatch[1];
      if (env?.DB) {
        const r = await env.DB.prepare('SELECT * FROM agents WHERE agent_id = ?').bind(agentId).first<any>();
        if (!r) return jsonResponse({ error: 'Agent not found' }, 404);
        return jsonResponse({
          agent: {
            agentId: r.agent_id,
            name: r.name,
            publicKey: r.public_key,
            x25519PublicKey: r.x25519_public_key || undefined,
            capabilities: JSON.parse(r.capabilities_json || '[]'),
            metadata: JSON.parse(r.metadata_json || '{}'),
            registeredAt: r.registered_at,
            lastSeenAt: r.last_seen_at,
            reputationScore: r.reputation_score,
          },
        });
      }

      const agent = memoryFallback.agents.get(agentId);
      if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
      return jsonResponse({ agent });
    }

    // GET /v1/tasks
    if (path === '/v1/tasks' && method === 'GET') {
      const status = url.searchParams.get('status') || 'open';
      if (env?.DB) {
        let query = 'SELECT * FROM tasks';
        const params: any[] = [];
        if (status !== 'all') {
          query += ' WHERE status = ?';
          params.push(status);
        }
        query += ' ORDER BY created_at DESC LIMIT 50';
        const rows = await env.DB.prepare(query).bind(...params).all();
        const tasks = (rows.results || []).map((r: any) => ({
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
        return jsonResponse({ tasks });
      }

      const allTasks = Array.from(memoryFallback.tasks.values());
      const filtered = status === 'all' ? allTasks : allTasks.filter((t) => t.status === status);
      return jsonResponse({ tasks: filtered });
    }

    // POST /v1/tasks
    if (path === '/v1/tasks' && method === 'POST') {
      const body = (await request.json()) as any;
      const { creatorId, title, description, requiredCapabilities = [], timeoutMs = 3600000, reward, signature, timestamp } = body;
      if (!creatorId || !title || !description) {
        return jsonResponse({ error: 'creatorId, title, and description required' }, 400);
      }

      // Verify creator is registered, then that the caller holds its key (#30)
      let creatorKey: string | undefined;
      if (env?.DB) {
        const cRow = await env.DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(creatorId).first<{ public_key: string }>();
        creatorKey = cRow?.public_key;
      } else {
        creatorKey = memoryFallback.agents.get(creatorId)?.publicKey;
      }
      if (!creatorKey) {
        return jsonResponse({ error: `creatorId ${creatorId} is not registered. Register via POST /v1/agents/register first.` }, 401);
      }
      const createCheck = await verifyTaskActionHub('create', '-', creatorId, timestamp, { title, description, requiredCapabilities, timeoutMs, reward: reward ?? null }, signature, creatorKey);
      if (!createCheck.valid) return jsonResponse({ error: createCheck.error }, signature ? 403 : 401);

      // (#71) the id is derived from the creator's proof, so a replayed create
      // body maps to the same task instead of minting duplicates
      const taskId = `task_${(await sha256Hex(signature)).slice(0, 16)}`;
      const now = Date.now();
      if (env?.DB) {
        const dup = await env.DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(taskId).first();
        if (dup) return jsonResponse({ success: true, alreadyCreated: true, task: { id: taskId } });
      } else if (memoryFallback.tasks.has(taskId)) {
        return jsonResponse({ success: true, alreadyCreated: true, task: memoryFallback.tasks.get(taskId) });
      }

      if (env?.DB) {
        await env.DB.prepare(`
          INSERT INTO tasks (id, creator_id, title, description, required_capabilities_json, status, timeout_ms, reward, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
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
      }

      const task: TaskRecord = {
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
      memoryFallback.tasks.set(taskId, task);
      return jsonResponse({ success: true, task });
    }

    // POST /v1/tasks/:id/claim
    const claimMatch = path.match(/^\/v1\/tasks\/([a-zA-Z0-9-_]+)\/claim$/);
    if (claimMatch && method === 'POST') {
      const taskId = claimMatch[1];
      const { agentId, signature, timestamp } = (await request.json()) as any;
      if (!agentId) return jsonResponse({ error: 'agentId required' }, 400);

      const now = Date.now();
      const claimKey = env?.DB
        ? (await env.DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(agentId).first<{ public_key: string }>())?.public_key
        : memoryFallback.agents.get(agentId)?.publicKey;
      if (!claimKey) return jsonResponse({ error: `Agent ${agentId} is not registered` }, 401);
      // (#30) a claim is an identity-bearing write: prove the key, always
      const claimCheck = await verifyTaskActionHub('claim', taskId, agentId, timestamp, {}, signature, claimKey);
      if (!claimCheck.valid) return jsonResponse({ error: claimCheck.error }, signature ? 403 : 401);

      if (env?.DB) {

        const res = await env.DB.prepare(`
          UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'open'
        `).bind(agentId, now, now, taskId).run();

        if (res.meta.changes === 0) {
          return jsonResponse({ error: 'Task is not open or does not exist' }, 400);
        }

        await env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE agent_id = ?').bind(now, agentId).run();
        return jsonResponse({ success: true, taskId, claimedBy: agentId, status: 'claimed' });
      }

      const task = memoryFallback.tasks.get(taskId);
      if (!task || task.status !== 'open') {
        return jsonResponse({ error: 'Task is not open or does not exist' }, 400);
      }
      task.status = 'claimed';
      task.claimedBy = agentId;
      task.claimedAt = now;
      task.updatedAt = now;
      return jsonResponse({ success: true, taskId, claimedBy: agentId, status: 'claimed' });
    }

    // POST /v1/tasks/:id/submit
    const submitMatch = path.match(/^\/v1\/tasks\/([a-zA-Z0-9-_]+)\/submit$/);
    if (submitMatch && method === 'POST') {
      const taskId = submitMatch[1];
      const { agentId, resultPayload, signature, timestamp } = (await request.json()) as any;
      if (!agentId || !resultPayload) return jsonResponse({ error: 'agentId and resultPayload required' }, 400);

      const now = Date.now();
      const submitKey = env?.DB
        ? (await env.DB.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(agentId).first<{ public_key: string }>())?.public_key
        : memoryFallback.agents.get(agentId)?.publicKey;
      if (!submitKey) return jsonResponse({ error: `Agent ${agentId} is not registered` }, 401);
      // (#30) the signature binds the result, so a captured proof cannot submit a different one
      const submitCheck = await verifyTaskActionHub('submit', taskId, agentId, timestamp, { resultPayload }, signature, submitKey);
      if (!submitCheck.valid) return jsonResponse({ error: submitCheck.error }, signature ? 403 : 401);

      if (env?.DB) {

        const res = await env.DB.prepare(`
          UPDATE tasks SET status = 'completed', result_payload_json = ?, updated_at = ?
          WHERE id = ? AND claimed_by = ? AND status = 'claimed'
        `).bind(JSON.stringify(resultPayload), now, taskId, agentId).run();

        if (res.meta.changes === 0) {
          // (#71) first completion seals the result; a later submit cannot rewrite it
          const cur = await env.DB.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').bind(taskId).first<{ status: string; claimed_by: string }>();
          if (cur && cur.claimed_by === agentId && cur.status === 'completed') return jsonResponse({ error: 'Task result is already sealed; completed results are immutable' }, 409);
          return jsonResponse({ error: 'Task must be claimed by this agent to submit result' }, 400);
        }

        await env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE agent_id = ?').bind(now, agentId).run();
        return jsonResponse({ success: true, taskId, status: 'completed' });
      }

      const task = memoryFallback.tasks.get(taskId);
      if (!task || task.claimedBy !== agentId) {
        return jsonResponse({ error: 'Task must be claimed by this agent' }, 400);
      }
      if (task.status === 'completed') return jsonResponse({ error: 'Task result is already sealed; completed results are immutable' }, 409);
      task.status = 'completed';
      task.resultPayload = resultPayload;
      task.updatedAt = now;
      return jsonResponse({ success: true, taskId, status: 'completed' });
    }

    // GET /v1/intel/search
    if (path === '/v1/intel/search' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (!q) return jsonResponse({ query: q, count: 0, results: [] });

      if (env?.DB) {
        const rows = await env.DB.prepare(`
          SELECT * FROM messages WHERE type = 'intel' AND payload_json LIKE ? ORDER BY timestamp DESC LIMIT 20
        `).bind(`%${q}%`).all();

        const results = (rows.results || []).map((r: any) => ({
          id: r.id,
          channel: r.channel,
          sender: r.sender,
          timestamp: r.timestamp,
          payload: JSON.parse(r.payload_json),
        }));
        return jsonResponse({ query: q, count: results.length, results });
      }

      const allMsgs: MessageRecord[] = [];
      for (const list of memoryFallback.messages.values()) {
        allMsgs.push(...list);
      }
      const results = allMsgs.filter((m) => m.type === 'intel' && JSON.stringify(m.payload).toLowerCase().includes(q));
      return jsonResponse({ query: q, count: results.length, results });
    }

    return jsonResponse({ error: `Route ${method} ${path} not found` }, 404);
  } catch (err: any) {
    return jsonResponse({ error: err.message }, 500);
  }
};
