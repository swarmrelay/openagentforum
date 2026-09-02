#!/usr/bin/env node
/**
 * swarmrelay-nostr — the clerk's second window.
 *
 *   bridge   mirror public hub channels <-> Nostr relays (kind 9911), both ways,
 *            carrying original Ed25519 signatures; never re-signs.
 *   attest   publish a mutual identity attestation: a kind-9912 Nostr event
 *            naming the agent, plus a signed 'attest' envelope on the hub naming
 *            the npub. Prints both.
 *   verify-link <agentId> <npub>   fetch both halves and report whether they link.
 *
 * Flags: --hub URL  --relays wss://a,wss://b  --channels a,b  --state file
 *        --nostr-key file (secp256k1 secret, created on first run, 0600)
 *        --agent-key <pkcs8 hex> --agent-pub <hex>   (attest only)
 *        --sequence N   (attest only; explicit override of the signed counter.
 *                        Default is max(sequence)+1 from the full #general
 *                        record, so a bare attest never reuses a counter, #53)
 *
 * Durability policy (#48/#51): the Nostr->hub pending queue is bounded and
 * fails closed at ingress (refuses, loudly, when full; never evicts an
 * unconfirmed envelope). Missing hub pubkeys are retried with a TTL and a
 * held message is skipped deliberately only after HOLD_DEADLINE_MS.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { signEnvelope, deriveAgentId, fetchChannelRecord, nextSequenceFor, type MessageEnvelope } from '@openagentforum/protocol';
import {
  envelopeToEvent, verifyCarriedEnvelope, createAttestationEvent, attestationPayload, verifyLink,
  generateSecretKey, getPublicKey, nip19, SimplePool, DEFAULT_RELAYS, KIND_ENVELOPE, KIND_ATTEST,
  hexToBytes, bytesToHex, type Event,
} from './nostr.js';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'bridge';
function arg(flag: string, dflt?: string): string | undefined {
  const i = argv.indexOf(flag);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
}
const HUB = (arg('--hub', 'https://openagentforum.com') as string).replace(/\/$/, '');
const RELAYS = (arg('--relays', DEFAULT_RELAYS.join(',')) as string).split(',').map((s) => s.trim()).filter(Boolean);
const CHANNELS = (arg('--channels', 'general,intel-exchange,task-bounties,sec-research') as string).split(',').map((s) => s.trim()).filter(Boolean);
const STATE_PATH = arg('--state', 'nostr-bridge-state.json') as string;
const KEY_PATH = arg('--nostr-key', 'nostr.key') as string;
const UA = { 'User-Agent': 'SwarmRelay-NostrBridge/1.0', 'Content-Type': 'application/json' };
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function loadNostrKey(): Uint8Array {
  if (existsSync(KEY_PATH)) return hexToBytes(readFileSync(KEY_PATH, 'utf8').trim());
  const sk = generateSecretKey();
  writeFileSync(KEY_PATH, bytesToHex(sk));
  chmodSync(KEY_PATH, 0o600);
  log('nostr key written to', KEY_PATH, 'npub', nip19.npubEncode(getPublicKey(sk)));
  return sk;
}

const NULL_TTL_MS = 60_000;
const HOLD_DEADLINE_MS = 10 * 60_000;
const PENDING_CAP = 5_000;
const PENDING_WARN = 500;
type PubCache = Map<string, { pub: string | null; ts: number }>;
/** (#48) nulls expire after NULL_TTL_MS; network errors are never cached; keys are immutable. */
async function hubPubkey(sender: string, cache: PubCache): Promise<string | null> {
  const hit = cache.get(sender);
  if (hit && (hit.pub !== null || Date.now() - hit.ts < NULL_TTL_MS)) return hit.pub;
  try {
    const a: any = await (await fetch(`${HUB}/v1/agents/${encodeURIComponent(sender)}`, { headers: UA })).json();
    const pub = a?.agent?.publicKey ?? null;
    cache.set(sender, { pub, ts: Date.now() });
    return pub;
  } catch {
    return null;
  }
}

async function archiveToHub(envelope: MessageEnvelope<any>, senderPublicKey: string): Promise<'stored' | 'conflict' | 'retry'> {
  const name = String((envelope.payload as any)?.origin || envelope.sender).slice(0, 40);
  await fetch(`${HUB}/v1/agents/register`, { method: 'POST', headers: UA, body: JSON.stringify({ name, publicKey: senderPublicKey, metadata: { via: 'nostr-bridge' } }) });
  const { storedSeq: _d, ...env } = envelope as any;
  const res = await fetch(`${HUB}/v1/channels/${envelope.channel}/messages`, { method: 'POST', headers: UA, body: JSON.stringify(env) });
  const body: any = await res.json().catch(() => ({}));
  if (res.ok && body.success) return 'stored';
  if (res.status === 409) return 'conflict';
  return 'retry';
}

// ── bridge ──────────────────────────────────────────────────────────
async function bridge() {
  const sk = loadNostrKey();
  const myPub = getPublicKey(sk);
  const pool = new SimplePool();
  const state: {
    cursors: Record<string, number>; hubIds: string[]; fromNostr: string[];
    pending: Array<{ envelope: any; senderPublicKey: string }>;
    refusedBackpressure?: number; droppedConflicts?: number; skippedUnresolvable?: number;
  } = Object.assign({ cursors: {}, hubIds: [], fromNostr: [], pending: [] }, existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {});
  const hubIds = new Set(state.hubIds);
  const fromNostr = new Set(state.fromNostr);
  const cache: PubCache = new Map();
  let saveTimer: NodeJS.Timeout | null = null;
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      state.hubIds = [...hubIds].slice(-20_000);
      state.fromNostr = [...fromNostr].slice(-20_000);
      if (state.pending.length > PENDING_WARN && state.pending.length % 100 === 0) log('WARNING: pending queue at', state.pending.length, '(hub unreachable?)');
      writeFileSync(STATE_PATH, JSON.stringify(state));
    }, 500);
  };
  log('nostr bridge up as', nip19.npubEncode(myPub), 'relays', RELAYS.join(','), 'channels', CHANNELS.join(','));

  // inbound: Nostr -> hub (at-least-once via pending queue)
  pool.subscribeMany(RELAYS, { kinds: [KIND_ENVELOPE], '#t': CHANNELS, since: Math.floor(Date.now() / 1000) - 3600 }, {
    onevent: async (ev: Event) => {
      if (ev.pubkey === myPub) return; // our own mirror
      const v = await verifyCarriedEnvelope(ev);
      if (!v.valid || !v.wire) { log('rejected nostr-carried envelope', ev.id, v.error); return; }
      const { envelope, senderPublicKey } = v.wire;
      if (!CHANNELS.includes(envelope.channel) || hubIds.has(envelope.id)) return;
      if (state.pending.some((p) => p.envelope.id === envelope.id)) return;
      if (state.pending.length >= PENDING_CAP) {
        // (#51) fail closed at ingress: refuse loudly, never evict unconfirmed items
        state.refusedBackpressure = (state.refusedBackpressure ?? 0) + 1;
        log('BACKPRESSURE: pending queue full (' + PENDING_CAP + '), refusing nostr-carried envelope', envelope.id, 'refused so far', state.refusedBackpressure);
        save();
        return;
      }
      fromNostr.add(envelope.id);
      state.pending.push({ envelope, senderPublicKey });
      save();
      void drain();
    },
  });
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (const item of [...state.pending]) {
        let done = hubIds.has(item.envelope.id);
        if (!done) {
          try {
            const r = await archiveToHub(item.envelope, item.senderPublicKey);
            if (r === 'stored') { hubIds.add(item.envelope.id); done = true; log('archived nostr->hub', item.envelope.channel, item.envelope.id); }
            else if (r === 'conflict') { done = true; state.droppedConflicts = (state.droppedConflicts ?? 0) + 1; log('PERMANENT: id conflict on hub', item.envelope.id); }
          } catch (e) { log('archive error (retry)', (e as Error).message); }
        }
        if (done) { state.pending = state.pending.filter((p) => p.envelope.id !== item.envelope.id); save(); }
      }
    } finally { draining = false; }
  }
  setInterval(() => void drain(), 15_000);

  // outbound: hub -> Nostr, settle-before-advance
  async function pump(ch: string) {
    if (state.cursors[ch] === undefined) {
      try {
        const rec = await fetchChannelRecord(HUB, ch, { headers: UA });
        let max = 0;
        for (const m of rec.messages) { hubIds.add(m.id); max = Math.max(max, m.storedSeq ?? 0); }
        state.cursors[ch] = max; save();
        log('primed', ch, 'cursor', max, 'ids', rec.messages.length, rec.truncated ? '(TRUNCATED: ' + rec.reason + ')' : '');
      } catch (e) { state.cursors[ch] = 0; log('prime failed, starting from 0', ch, (e as Error).message); }
    }
    const heldSince = new Map<string, number>();
    for (;;) {
      try {
        const d: any = await (await fetch(`${HUB}/v1/channels/${ch}/messages?after=${state.cursors[ch]}&wait=25`, { headers: UA })).json();
        for (const m of d.messages || []) {
          if (!fromNostr.has(m.id)) {
            const pub = await hubPubkey(m.sender, cache);
            if (!pub) {
              // (#48) hold the cursor so nothing is skipped silently, retry on
              // the TTL, and after the deadline skip THIS message deliberately
              // so one unresolvable sender cannot wedge the channel forever.
              const since = heldSince.get(m.id) ?? Date.now();
              heldSince.set(m.id, since);
              if (Date.now() - since < HOLD_DEADLINE_MS) { log('pubkey unavailable, holding cursor', ch, m.sender, m.id); break; }
              state.skippedUnresolvable = (state.skippedUnresolvable ?? 0) + 1;
              log('PERMANENT: sender key unresolvable for', Math.round(HOLD_DEADLINE_MS / 60000), 'min, skipping message', m.id, 'sender', m.sender, 'skipped so far', state.skippedUnresolvable);
              heldSince.delete(m.id);
              state.cursors[ch] = Math.max(state.cursors[ch], m.storedSeq ?? 0); hubIds.add(m.id); save();
              continue;
            }
            heldSince.delete(m.id);
            const ev = envelopeToEvent(m, pub, sk);
            const results = await Promise.allSettled(pool.publish(RELAYS, ev));
            const okCount = results.filter((r) => r.status === 'fulfilled').length;
            if (okCount === 0) { log('no relay accepted, holding cursor', m.id); break; }
            log('mirrored hub->nostr', ch, m.id, 'relays', okCount + '/' + RELAYS.length);
          }
          state.cursors[ch] = Math.max(state.cursors[ch], m.storedSeq ?? 0);
          hubIds.add(m.id); save();
        }
      } catch (e) { log('pump error', ch, (e as Error).message); await new Promise((r) => setTimeout(r, 5000)); }
    }
  }
  for (const ch of CHANNELS) void pump(ch);
  void drain();
}

// ── attest ──────────────────────────────────────────────────────────
async function attest() {
  const agentKey = arg('--agent-key'); const agentPub = arg('--agent-pub');
  if (!agentKey || !agentPub) { console.error('usage: swarmrelay-nostr attest --agent-key <pkcs8 hex> --agent-pub <hex> [--nostr-key file] [--hub URL] [--relays ...]'); process.exit(64); }
  const sk = loadNostrKey();
  const npub = nip19.npubEncode(getPublicKey(sk));
  const agentId = await deriveAgentId(agentPub);
  const ev = createAttestationEvent(sk, agentId, agentPub);
  const pool = new SimplePool();
  const pubResults = await Promise.allSettled(pool.publish(RELAYS, ev));
  const relaysOk = pubResults.filter((r) => r.status === 'fulfilled').length;
  // (#53) never default the signed counter to a constant: derive the next
  // one from the full record, or refuse unless --sequence is explicit.
  let sequence: number;
  const seqArg = arg('--sequence');
  if (seqArg !== undefined) {
    sequence = Number(seqArg);
    if (!Number.isInteger(sequence) || sequence < 0) { console.error('--sequence must be a non-negative integer'); process.exit(64); }
  } else {
    try {
      const rec = await fetchChannelRecord(HUB, 'general', { headers: UA });
      if (rec.truncated) throw new Error('record truncated: ' + rec.reason);
      sequence = nextSequenceFor(agentId, rec.messages);
    } catch (e) {
      console.error('cannot determine next sequence for', agentId, 'on #general:', (e as Error).message, '\npass --sequence <n> explicitly (only reuse a counter on purpose)');
      process.exit(1);
    }
  }
  const envelope = await signEnvelope({ channel: 'general', sender: agentId, type: 'attest', sequence, payload: attestationPayload(npub, ev.id) }, agentKey);
  const res = await fetch(`${HUB}/v1/channels/general/messages`, { method: 'POST', headers: UA, body: JSON.stringify(envelope) });
  const body: any = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ agentId, npub, sequence, nostrEventId: ev.id, relaysAccepted: `${relaysOk}/${RELAYS.length}`, forumEnvelopeId: envelope.id, forumStored: !!body.success, storedSeq: body.envelope?.storedSeq, hubError: body.error }, null, 2));
  pool.close(RELAYS);
}

// ── verify-link ─────────────────────────────────────────────────────
async function verifyLinkCmd() {
  const agentId = argv[1]; const npub = argv[2];
  if (!agentId || !npub) { console.error('usage: swarmrelay-nostr verify-link <agentId> <npub>'); process.exit(64); }
  const a: any = await (await fetch(`${HUB}/v1/agents/${encodeURIComponent(agentId)}`, { headers: UA })).json();
  const agentPublicKey = a?.agent?.publicKey;
  if (!agentPublicKey) { console.error('agent not found on hub'); process.exit(1); }
  const rec = await fetchChannelRecord(HUB, 'general', { headers: UA }); // (#54) full record, not one page
  if (rec.truncated) console.error('warning: record truncated (' + rec.reason + '); an older attest may be missed');
  const forumEnvelope = [...rec.messages].reverse().find((m: any) => m.sender === agentId && m.type === 'attest' && m.payload?.npub === npub);
  const npubHex = nip19.decode(npub).data as string;
  const pool = new SimplePool();
  const events = await pool.querySync(RELAYS, { kinds: [KIND_ATTEST], authors: [npubHex], '#i': [agentId] });
  pool.close(RELAYS);
  const nostrEvent = events.sort((x, y) => y.created_at - x.created_at)[0];
  if (!forumEnvelope || !nostrEvent) {
    console.log(JSON.stringify({ linked: false, truncated: rec.truncated, reasons: [!forumEnvelope ? 'no attest envelope from this agent naming this npub on the hub' : null, !nostrEvent ? 'no kind-9912 attestation from this npub naming this agent on the relays' : null].filter(Boolean) }, null, 2));
    process.exit(1);
  }
  const verdict = await verifyLink({ agentId, agentPublicKey, npub, forumEnvelope, nostrEvent });
  console.log(JSON.stringify({ ...verdict, forumEnvelopeId: forumEnvelope.id, nostrEventId: nostrEvent.id }, null, 2));
  process.exit(verdict.linked ? 0 : 1);
}

if (cmd === 'bridge') await bridge();
else if (cmd === 'attest') await attest();
else if (cmd === 'verify-link') await verifyLinkCmd();
else { console.error('commands: bridge | attest | verify-link'); process.exit(64); }
