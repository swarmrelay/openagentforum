/**
 * SwarmChannelDO - Cloudflare Durable Object for atomic real-time channel coordination
 * Uses modern DurableObject base class, SQLite storage, and WebSocket Hibernation API.
 */

import { DurableObject } from 'cloudflare:workers';
import type { MessageEnvelope, SwarmEvent } from '@openagentforum/protocol';
import type { Env } from './env.js';

const CACHE_ROWS = 500;
// Cache only: not an ingestion/frame limit or a bound on the durable ledger.
// UTF-8 stored text plus 32 bytes for numeric fields/rowid; excludes SQLite overhead.
const CACHE_ROW_BYTES = 64 * 1024;
const CACHE_TEXT_COLUMNS = ['id', 'sender', 'type', 'payload_json', 'signature', 'checksum', 'reply_to_id'];
const CACHE_ROW_SIZE_SQL = `32 + ${CACHE_TEXT_COLUMNS.map(column => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ')}`;
const utf8 = new TextEncoder();

interface CachedMessage {
  [key: string]: string | number | null;
  id: string;
  sender: string;
  type: string;
  sequence: number;
  timestamp: number;
  payload_json: string;
  signature: string;
  checksum: string;
  reply_to_id: string | null;
  encrypted: number;
}

export class SwarmChannelDO extends DurableObject<Env> {
  private channelName: string = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // Initialize channel SQLite schema inside Durable Object
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
        CREATE TABLE IF NOT EXISTS recent_messages (
          id TEXT PRIMARY KEY,
          sender TEXT NOT NULL,
          type TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          signature TEXT NOT NULL,
          checksum TEXT NOT NULL,
          reply_to_id TEXT,
          encrypted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_recent_seq ON recent_messages (sequence);
      `);
      // Repair legacy overfull caches on activation without touching the ledger
      // or sequence allocator. rowid is local insertion order, never author input.
      this.trimCache();
      this.ctx.storage.sql.exec(`DELETE FROM recent_messages WHERE ${CACHE_ROW_SIZE_SQL} > ?`, CACHE_ROW_BYTES);
      this.channelName = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'name'").toArray()[0]?.value ?? '';
    });
  }

  /**
   * Set channel name context
   */
  async initChannel(name: string): Promise<void> {
    this.channelName = name;
    this.ctx.storage.sql.exec(`
      INSERT OR REPLACE INTO meta (key, value) VALUES ('name', ?)
    `, name);
  }

  /**
   * Get and increment monotonic sequence counter for this channel
   */
  async getNextSequence(): Promise<number> {
    const row = this.ctx.storage.sql.exec<{ value: string }>(
      `SELECT value FROM meta WHERE key = 'current_sequence'`
    ).toArray();

    const current = row.length > 0 ? parseInt(row[0].value, 10) || 0 : 0;
    const next = current + 1;

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('current_sequence', ?)`,
      next.toString()
    );

    return next;
  }

  /**
   * Broadcast message envelope to all connected WebSockets and buffer in SQLite
   */
  async broadcastMessage(envelope: MessageEnvelope): Promise<void> {
    if (!this.channelName) {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('name', ?)", envelope.channel);
      this.channelName = envelope.channel;
    }
    // 1. Optional bounded cache; authoritative catch-up reads the durable ledger.
    const payloadJson = JSON.stringify(envelope.payload);
    const text = [envelope.id, envelope.sender, envelope.type, payloadJson,
      envelope.signature, envelope.checksum, envelope.replyToId || ''];
    const rowBytes = 32 + text.reduce((total, value) => total + utf8.encode(value).byteLength, 0);
    if (rowBytes <= CACHE_ROW_BYTES) this.ctx.storage.sql.exec(
      `INSERT INTO recent_messages (
        id, sender, type, sequence, timestamp, payload_json, signature, checksum, reply_to_id, encrypted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      envelope.id,
      envelope.sender,
      envelope.type,
      envelope.sequence,
      envelope.timestamp,
      payloadJson,
      envelope.signature,
      envelope.checksum,
      envelope.replyToId || null,
      envelope.encrypted ? 1 : 0
    );

    // No await between insertion and eviction. Duplicate IDs do not refresh
    // their cache position or replace the first cached copy.
    this.trimCache();

    // 2. Broadcast to all active hibernated WebSockets
    const eventPayload: SwarmEvent<MessageEnvelope> = {
      event: 'message',
      channel: envelope.channel,
      data: envelope,
      timestamp: Date.now(),
    };

    const messageString = JSON.stringify(eventPayload);
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(messageString);
      } catch {
        // Socket closed or errored, hibernation runtime will clean up
      }
    }
  }

  private trimCache(): void {
    this.ctx.storage.sql.exec(`
      DELETE FROM recent_messages WHERE rowid NOT IN (
        SELECT rowid FROM recent_messages ORDER BY rowid DESC LIMIT ?
      )
    `, CACHE_ROWS);
  }

  /**
   * Broadcast arbitrary Swarm event (presence, task updates, heartbeats)
   */
  async broadcastEvent(event: SwarmEvent): Promise<void> {
    const messageString = JSON.stringify(event);
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(messageString);
      } catch {}
    }
  }

  /**
   * Fetch recent cached messages in local first-arrival order, not a ledger cursor.
   */
  async getRecentMessages(limit: number = 50): Promise<MessageEnvelope[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CACHE_ROWS) {
      throw new RangeError(`Cache limit must be an integer from 1 to ${CACHE_ROWS}`);
    }
    const rows = this.ctx.storage.sql.exec<CachedMessage>(`
      SELECT * FROM recent_messages ORDER BY rowid DESC LIMIT ?
    `, limit).toArray();

    return rows.reverse().map((r) => ({
      id: r.id,
      channel: this.channelName,
      sender: r.sender,
      type: r.type as any,
      sequence: r.sequence,
      timestamp: r.timestamp,
      payload: JSON.parse(r.payload_json),
      signature: r.signature,
      checksum: r.checksum,
      replyToId: r.reply_to_id || undefined,
      encrypted: r.encrypted === 1,
    }));
  }

  /**
   * HTTP entry: WebSocket upgrades come in here via stub.fetch(). A 101
   * Response carrying a WebSocket cannot cross the RPC boundary (DataCloneError),
   * so callers must forward the raw upgrade request instead of calling
   * handleWebSocket() over RPC. Query: ?channel=<name>&agent=<id>
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const name = url.searchParams.get('channel') || this.channelName;
    if (name) await this.initChannel(name);
    return this.handleWebSocket(url.searchParams.get('agent') || undefined);
  }

  /**
   * Handle incoming WebSocket connection upgrade (call via fetch(), not RPC)
   */
  async handleWebSocket(agentId?: string): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept WebSocket with tag for agent identification
    const tags = agentId ? [agentId] : ['anonymous'];
    this.ctx.acceptWebSocket(server, tags);

    // Send initial handshake
    server.send(
      JSON.stringify({
        event: 'connected',
        channel: this.channelName,
        timestamp: Date.now(),
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * WebSocket Hibernation Event: Message received
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch {}
    }
  }

  /**
   * WebSocket Hibernation Event: Close
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    ws.close(code, 'Swarm session ended');
  }

  /**
   * WebSocket Hibernation Event: Error
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    ws.close(1011, 'Internal mesh error');
  }
}
