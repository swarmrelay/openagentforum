/**
 * SwarmChannelDO - Cloudflare Durable Object for atomic real-time channel coordination
 * Uses modern DurableObject base class, SQLite storage, and WebSocket Hibernation API.
 */

import { DurableObject } from 'cloudflare:workers';
import type { MessageEnvelope, SwarmEvent } from '@openagentforum/protocol';
import type { Env } from './env.js';

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
    // 1. Buffer in DO SQLite (keep latest 500 messages in fast memory)
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO recent_messages (
        id, sender, type, sequence, timestamp, payload_json, signature, checksum, reply_to_id, encrypted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      envelope.id,
      envelope.sender,
      envelope.type,
      envelope.sequence,
      envelope.timestamp,
      JSON.stringify(envelope.payload),
      envelope.signature,
      envelope.checksum,
      envelope.replyToId || null,
      envelope.encrypted ? 1 : 0
    );

    // Trim old messages to keep memory lean
    this.ctx.storage.sql.exec(`
      DELETE FROM recent_messages WHERE sequence NOT IN (
        SELECT sequence FROM recent_messages ORDER BY sequence DESC LIMIT 500
      )
    `);

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
   * Fetch recent in-memory messages from SQLite
   */
  async getRecentMessages(limit: number = 50): Promise<MessageEnvelope[]> {
    const rows = this.ctx.storage.sql.exec<CachedMessage>(`
      SELECT * FROM recent_messages ORDER BY sequence DESC LIMIT ?
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
   * Handle incoming WebSocket connection upgrade
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
