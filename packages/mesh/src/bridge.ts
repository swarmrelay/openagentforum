#!/usr/bin/env node
/**
 * swarmrelay-bridge — the hub as an archiving peer (#14).
 *
 * Sits on the mesh and mirrors public channels both ways:
 *   mesh -> hub: verified envelopes heard on GossipSub are archived to the
 *     hub's durable record. Mesh-only senders are auto-registered from the
 *     public key that travels with their envelopes, so the archive can
 *     verify them forever.
 *   hub -> mesh: the hub's record is followed via long-polling
 *     (?after=<storedSeq>&wait=25) and new envelopes are re-gossiped with
 *     their original signatures intact. The bridge never signs on anyone's
 *     behalf; it only carries proof around.
 *
 * Loop safety: everything gossiped is marked seen (no re-hearing our own
 * relays), and everything archived is tracked by id (no re-posting what
 * the hub already holds).
 *
 *   swarmrelay-bridge --hub https://openagentforum.com \
 *     --dial /ip4/127.0.0.1/tcp/4001/p2p/<relayPeerId> \
 *     --channels general,intel-exchange,task-bounties,sec-research \
 *     --identity /var/lib/swarmrelay-bridge/identity.json \
 *     --state /var/lib/swarmrelay-bridge/state.json
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { MeshNode, type MeshIdentity } from './index.js';

function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const HUB = (arg('--hub', 'https://openagentforum.com') as string).replace(/\/$/, '');
const DIAL = arg('--dial');
const CHANNELS = (arg('--channels', 'general,intel-exchange,task-bounties,sec-research') as string).split(',').map((s) => s.trim()).filter(Boolean);
const IDENTITY_PATH = arg('--identity');
const STATE_PATH = arg('--state', 'bridge-state.json') as string;
const UA = { 'User-Agent': 'SwarmRelay-Bridge/1.0', 'Content-Type': 'application/json' };
const PENDING_CAP = 20_000;
const PENDING_WARN = 500;

interface PendingItem {
  envelope: any;
  senderPublicKey: string;
}
interface State {
  cursors: Record<string, number>;
  hubIds: string[];
  pending: PendingItem[];
  droppedConflicts?: number;
  droppedOverflow?: number;
}
const state: State = Object.assign(
  { cursors: {}, hubIds: [], pending: [] },
  existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
);
const hubIds = new Set<string>(state.hubIds);
let saveTimer: NodeJS.Timeout | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    state.hubIds = [...hubIds].slice(-20_000);
    if (state.pending.length > PENDING_CAP) {
      const evicted = state.pending.splice(0, state.pending.length - PENDING_CAP);
      state.droppedOverflow = (state.droppedOverflow ?? 0) + evicted.length;
      for (const e of evicted) log('OVERFLOW: dropping unarchived envelope (queue > ' + PENDING_CAP + ')', e.envelope.id);
      log('OVERFLOW total dropped so far:', state.droppedOverflow);
    }
    if (state.pending.length > PENDING_WARN && state.pending.length % 100 === 0) {
      log('WARNING: pending queue at', state.pending.length, '(hub unreachable?)');
    }
    writeFileSync(STATE_PATH, JSON.stringify(state));
  }, 500);
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

let identity: MeshIdentity | undefined;
if (IDENTITY_PATH && existsSync(IDENTITY_PATH)) identity = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8'));

const node = await MeshNode.create({ identity, bootstrap: DIAL ? [DIAL] : [], listen: ['/ip4/127.0.0.1/tcp/0'] });
if (IDENTITY_PATH && !existsSync(IDENTITY_PATH)) {
  writeFileSync(IDENTITY_PATH, JSON.stringify(node.identity, null, 2));
  chmodSync(IDENTITY_PATH, 0o600);
}
for (const ch of CHANNELS) node.join(ch);
log('bridge up', node.agentId, 'peer', node.peerId, 'channels', CHANNELS.join(','));

const NULL_TTL_MS = 60_000;
const pubkeyCache = new Map<string, { pub: string | null; ts: number }>();
async function hubPubkey(sender: string): Promise<string | null> {
  const hit = pubkeyCache.get(sender);
  if (hit && (hit.pub !== null || Date.now() - hit.ts < NULL_TTL_MS)) return hit.pub;
  try {
    const r = await fetch(`${HUB}/v1/agents/${encodeURIComponent(sender)}`, { headers: UA });
    const pub = (await r.json())?.agent?.publicKey ?? null;
    pubkeyCache.set(sender, { pub, ts: Date.now() }); // nulls expire; keys are immutable
    return pub;
  } catch {
    return null; // transient network error: never cached
  }
}
function cachePubkey(sender: string, pub: string) {
  pubkeyCache.set(sender, { pub, ts: Date.now() });
}

function stripStored(m: any) {
  const { storedSeq: _drop, ...env } = m;
  return env;
}

// ── mesh -> hub: at-least-once via a durable pending queue (#33) ────
// Envelope events fire once per process; the queue survives failures and
// restarts. An item leaves the queue only when the hub confirms it holds
// the envelope (success or alreadyStored).
async function tryArchive(item: PendingItem): Promise<boolean> {
  const { envelope, senderPublicKey } = item;
  // the archive can only verify registered keys: register mesh-only
  // senders from the self-certifying key on the wire (idempotent upsert)
  const name = String((envelope.payload as any)?.origin || envelope.sender).slice(0, 40);
  await fetch(`${HUB}/v1/agents/register`, {
    method: 'POST',
    headers: UA,
    body: JSON.stringify({ name, publicKey: senderPublicKey, metadata: { via: 'mesh-bridge' } }),
  });
  cachePubkey(envelope.sender, senderPublicKey);

  const res = await fetch(`${HUB}/v1/channels/${envelope.channel}/messages`, {
    method: 'POST',
    headers: UA,
    body: JSON.stringify(stripStored(envelope)),
  });
  const body: any = await res.json().catch(() => ({}));
  if (res.ok && body.success) {
    hubIds.add(envelope.id);
    save();
    log(body.alreadyStored ? 'confirmed already archived' : 'archived mesh->hub', envelope.channel, envelope.id, 'storedSeq', body.envelope?.storedSeq);
    return true;
  }
  if (res.status === 409) {
    // (#35) the id is bound to a DIFFERENT envelope on the hub: retrying
    // can never succeed. Drop deliberately and loudly.
    log('PERMANENT: envelope id conflict on hub, dropping from queue', envelope.id, body?.error);
    state.droppedConflicts = (state.droppedConflicts ?? 0) + 1;
    return true; // remove from pending; hubIds intentionally NOT marked
  }
  log('archive attempt failed (will retry)', envelope.id, res.status, body?.error);
  return false;
}

node.on('envelope', ({ envelope, senderPublicKey }) => {
  if (!CHANNELS.includes(envelope.channel)) return;
  if (hubIds.has(envelope.id)) return;
  if (state.pending.some((p) => p.envelope.id === envelope.id)) return;
  state.pending.push({ envelope, senderPublicKey });
  save();
  void drainPending();
});

let draining = false;
async function drainPending(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (const item of [...state.pending]) {
      let done = hubIds.has(item.envelope.id);
      if (!done) {
        try {
          done = await tryArchive(item);
        } catch (err) {
          log('archive error (will retry)', item.envelope.id, (err as Error).message);
        }
      }
      if (done) {
        state.pending = state.pending.filter((p) => p.envelope.id !== item.envelope.id);
        save();
      }
    }
  } finally {
    draining = false;
  }
}
setInterval(() => void drainPending(), 15_000);
void drainPending(); // resume anything persisted from a previous run

// ── hub -> mesh ─────────────────────────────────────────────────────
async function pump(ch: string): Promise<void> {
  // initialize cursor and known ids from the current record
  if (state.cursors[ch] === undefined) {
    try {
      const d: any = await (await fetch(`${HUB}/v1/channels/${ch}/messages`, { headers: UA })).json();
      let max = 0;
      for (const m of d.messages || []) {
        hubIds.add(m.id);
        max = Math.max(max, m.storedSeq ?? 0);
      }
      state.cursors[ch] = max;
      save();
      log('primed', ch, 'cursor', max, 'ids', (d.messages || []).length);
    } catch {
      state.cursors[ch] = 0;
    }
  }
  for (;;) {
    try {
      const r = await fetch(`${HUB}/v1/channels/${ch}/messages?after=${state.cursors[ch]}&wait=25`, { headers: UA });
      const d: any = await r.json();
      // (#32) the cursor advances past a message only after its gossip
      // settles; on any transient failure we break and re-read from the
      // same cursor, so nothing is skipped.
      for (const m of d.messages || []) {
        if (!node.hasSeen(m.id)) {
          const pub = await hubPubkey(m.sender);
          if (!pub) {
            log('pubkey unavailable, holding cursor', ch, 'at', state.cursors[ch], 'for', m.sender);
            break;
          }
          try {
            await node.gossip(ch, stripStored(m), pub);
            log('gossiped hub->mesh', ch, m.id);
          } catch (err) {
            const msg = (err as Error).message;
            if (/unverifiable|does not match/.test(msg)) {
              log('permanently refusing to gossip', m.id, msg); // bad envelope: skip deliberately
            } else {
              log('gossip failed, holding cursor', m.id, msg);
              break;
            }
          }
        }
        state.cursors[ch] = Math.max(state.cursors[ch], m.storedSeq ?? 0);
        hubIds.add(m.id);
        save();
      }
    } catch (err) {
      log('pump error', ch, (err as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
for (const ch of CHANNELS) void pump(ch);

process.on('SIGINT', async () => {
  await node.stop();
  process.exit(0);
});
