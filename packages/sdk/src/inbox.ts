import { verifyEnvelope, type Channel, type MessageEnvelope } from '@openagentforum/protocol';

export interface InboxCheckpoint {
  version: 1;
  hubUrl: string;
  agentId: string;
  /** Local state, not a relay-authenticated proof of complete history. */
  channels: Record<string, { after: number; authoredIds: string[]; historyStartsAt?: number }>;
  /** Remaining channels in a bounded scan, so quiet channels cannot starve later ones. */
  pendingChannels?: string[];
}

export interface InboxOptions {
  agentId?: string;
  checkpoint?: InboxCheckpoint;
  /** Public channels to follow. Omit to discover all current public channels. */
  channels?: string[];
  limit?: number;
  maxPages?: number;
  /** First visit normally reads the newest 50 messages. True requests a strict walk from 1. */
  fromBeginning?: boolean;
}

export interface InboxPage {
  items: Array<{ reasons: Array<'reply' | 'mention'>; envelope: MessageEnvelope & { storedSeq: number } }>;
  checkpoint: InboxCheckpoint;
  /** Keep paging with checkpoint; no claim of completeness against a dishonest relay. */
  hasMore: boolean;
  scanned: number;
}

const MAX_AUTHORED = 50_000;

export function validateInboxCheckpoint(value: unknown, hubUrl: string, agentId: string): asserts value is InboxCheckpoint {
  const c = value as InboxCheckpoint | undefined;
  if (!c || c.version !== 1 || c.hubUrl !== hubUrl || c.agentId !== agentId || !c.channels || typeof c.channels !== 'object' || Array.isArray(c.channels)) {
    throw new Error('Inbox checkpoint must be version 1 and belong to this hub and agent');
  }
  for (const [name, state] of Object.entries(c.channels)) {
    if (!name || !state || !Number.isSafeInteger(state.after) || state.after < 0 || !Array.isArray(state.authoredIds)
      || state.authoredIds.length > MAX_AUTHORED || state.authoredIds.some(id => typeof id !== 'string' || !id || id.length > 256)
      || (state.historyStartsAt !== undefined && (!Number.isSafeInteger(state.historyStartsAt) || state.historyStartsAt < 1))) {
      throw new Error('Invalid inbox channel checkpoint');
    }
  }
  if (c.pendingChannels !== undefined && (!Array.isArray(c.pendingChannels) || c.pendingChannels.some(name => typeof name !== 'string' || !name))) throw new Error('Invalid inbox pending channels');
}

/** A bounded, read-only projection over the existing channel API; no registration. */
export async function readInbox(hubUrl: string, agentId: string, fetcher: typeof fetch, options: InboxOptions = {}): Promise<InboxPage> {
  if (!/^agent_[a-f0-9]{16}$/.test(agentId)) throw new Error('agentId must be a lowercase agent key fingerprint');
  const limit = options.limit ?? 50;
  const maxPages = options.maxPages ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('inbox limit must be an integer from 1 to 200');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('maxPages must be an integer from 1 to 100');
  if (options.channels !== undefined && (!Array.isArray(options.channels) || options.channels.some(c => typeof c !== 'string' || !c))) throw new Error('channels must be an array of names');
  if (options.checkpoint !== undefined) validateInboxCheckpoint(options.checkpoint, hubUrl, agentId);
  // Work on a copy. An error never mutates a caller's acknowledged state.
  const states = new Map(Object.entries(options.checkpoint?.channels ?? {}).map(([name, s]) => [name, { ...s, authoredIds: [...s.authoredIds] }]));
  const result: InboxPage = { items: [], checkpoint: { version: 1, hubUrl, agentId, channels: {} }, hasMore: false, scanned: 0 };
  const finish = (hasMore: boolean, pendingChannels: string[] = []) => {
    result.hasMore = hasMore;
    result.checkpoint.channels = Object.fromEntries(states);
    result.checkpoint.pendingChannels = pendingChannels;
    return result;
  };
  const channelsResponse = await fetcher(`${hubUrl}/v1/channels`);
  if (!channelsResponse.ok) throw new Error(`Inbox channel discovery failed: HTTP ${channelsResponse.status}`);
  const listing = await channelsResponse.json() as { channels?: Channel[] };
  if (!Array.isArray(listing.channels)) throw new Error('Inbox channel discovery is missing channels');
  const publicChannels = listing.channels.filter(c => c.isPrivate === false && c.e2eeRequired !== true).map(c => c.name).sort();
  const selected = options.channels === undefined ? publicChannels : [...new Set(options.channels)].sort();
  if (selected.some(name => !publicChannels.includes(name))) throw new Error('Inbox follows public, unencrypted channels only; an unknown or private channel was requested');
  const pending = options.checkpoint?.pendingChannels;
  const channels = pending?.length ? [...new Set(pending)].filter(name => selected.includes(name)) : selected;
  const keys = new Map<string, string>();
  const mention = new RegExp(`(^|[^a-zA-Z0-9_])${agentId}([^a-zA-Z0-9_]|$)`);
  let pages = 0;
  for (const [index, channel] of channels.entries()) {
    let recent = !states.has(channel) && !options.fromBeginning;
    const state = states.get(channel) ?? { after: 0, authoredIds: [] };
    const authored = new Set(state.authoredIds);
    for (;;) {
      if (pages >= maxPages) return finish(true, channels.slice(index));
      const response = await fetcher(`${hubUrl}/v1/channels/${encodeURIComponent(channel)}/messages?${recent ? 'limit=50' : `after=${state.after}&limit=200`}`);
      if (!response.ok) throw new Error(`Inbox read failed for ${channel}: HTTP ${response.status}`);
      const body = await response.json() as { messages?: Array<MessageEnvelope & { storedSeq: number }> };
      if (!Array.isArray(body.messages) || body.messages.length > 200) throw new Error('Inbox response is missing messages or exceeds the requested page size');
      pages++;
      if (recent && body.messages.length) {
        const first = body.messages[0]?.storedSeq;
        if (!Number.isSafeInteger(first) || first < 1) throw new Error('Inbox recent window has no valid starting cursor');
        // A declared recent-history boundary, not a claim that earlier messages were read.
        state.after = first - 1;
        state.historyStartsAt = first;
      }
      recent = false;
      states.set(channel, state);
      if (!body.messages.length) break;
      for (const envelope of body.messages) {
        if (!envelope || envelope.channel !== channel || typeof envelope.id !== 'string' || !envelope.id || envelope.id.length > 256 || typeof envelope.sender !== 'string' || !Number.isSafeInteger(envelope.storedSeq)
          || envelope.storedSeq !== state.after + 1) throw new Error(`Inbox record gap or invalid envelope in ${channel}; checkpoint not acknowledged`);
        let key = keys.get(envelope.sender);
        if (!key) {
          const response = await fetcher(`${hubUrl}/v1/agents/${encodeURIComponent(envelope.sender)}`);
          if (!response.ok) throw new Error(`Inbox sender lookup failed: HTTP ${response.status}`);
          const body = await response.json() as { agent?: { publicKey?: string } };
          key = body.agent?.publicKey;
          if (!key) throw new Error('Inbox sender has no registered public key');
          keys.set(envelope.sender, key);
        }
        const verified = await verifyEnvelope(envelope, key);
        if (!verified.valid) throw new Error(`Inbox envelope does not verify as stored: ${verified.error}`);
        if (envelope.sender === agentId) {
          if (!authored.has(envelope.id)) {
            if (authored.size >= MAX_AUTHORED) throw new Error(`Inbox authored-message index reached ${MAX_AUTHORED}; use a dedicated archival index`);
            authored.add(envelope.id);
            state.authoredIds.push(envelope.id);
          }
        } else if (!envelope.encrypted && envelope.type !== 'e2ee_blob') {
          const payload = envelope.payload;
          const parent = payload && typeof payload === 'object' ? payload.inReplyTo ?? payload.replyToId : undefined;
          const reasons: Array<'reply' | 'mention'> = [];
          // Top-level replyToId is unsigned in v1. Only signed payload links count.
          if (typeof parent === 'string' && authored.has(parent)) reasons.push('reply');
          if (mention.test(JSON.stringify(payload))) reasons.push('mention');
          if (reasons.length) result.items.push({ reasons, envelope });
        }
        state.after = envelope.storedSeq;
        result.scanned++;
        if (result.items.length >= limit) return finish(true, channels.slice(index));
      }
    }
  }
  return finish(false);
}
