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

interface State {
  cursors: Record<string, number>;
  hubIds: string[];
}
const state: State = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  : { cursors: {}, hubIds: [] };
const hubIds = new Set<string>(state.hubIds);
let saveTimer: NodeJS.Timeout | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    state.hubIds = [...hubIds].slice(-20_000);
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

const pubkeyCache = new Map<string, string | null>();
async function hubPubkey(sender: string): Promise<string | null> {
  if (!pubkeyCache.has(sender)) {
    try {
      const r = await fetch(`${HUB}/v1/agents/${encodeURIComponent(sender)}`, { headers: UA });
      const pub = (await r.json())?.agent?.publicKey ?? null;
      pubkeyCache.set(sender, pub);
    } catch {
      return null; // transient: do not cache
    }
  }
  return pubkeyCache.get(sender) ?? null;
}

function stripStored(m: any) {
  const { storedSeq: _drop, ...env } = m;
  return env;
}

// ── mesh -> hub ─────────────────────────────────────────────────────
node.on('envelope', async ({ envelope, senderPublicKey }) => {
  try {
    if (!CHANNELS.includes(envelope.channel)) return;
    if (hubIds.has(envelope.id)) return;

    // the archive can only verify registered keys: register mesh-only
    // senders from the self-certifying key on the wire (idempotent upsert)
    const name = String((envelope.payload as any)?.origin || envelope.sender).slice(0, 40);
    await fetch(`${HUB}/v1/agents/register`, {
      method: 'POST',
      headers: UA,
      body: JSON.stringify({ name, publicKey: senderPublicKey, metadata: { via: 'mesh-bridge' } }),
    });
    pubkeyCache.set(envelope.sender, senderPublicKey);

    const res = await fetch(`${HUB}/v1/channels/${envelope.channel}/messages`, {
      method: 'POST',
      headers: UA,
      body: JSON.stringify(stripStored(envelope)),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && body.success) {
      hubIds.add(envelope.id);
      save();
      log('archived mesh->hub', envelope.channel, envelope.id, 'storedSeq', body.envelope?.storedSeq);
    } else if (res.status === 503 || /unique/i.test(body?.error || '')) {
      hubIds.add(envelope.id); // already in the record
      save();
    } else {
      log('archive failed', envelope.id, res.status, body?.error);
    }
  } catch (err) {
    log('mesh->hub error', (err as Error).message);
  }
});

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
      for (const m of d.messages || []) {
        state.cursors[ch] = Math.max(state.cursors[ch], m.storedSeq ?? 0);
        hubIds.add(m.id);
        save();
        if (node.hasSeen(m.id)) continue; // originated on the mesh; peers have it
        const pub = await hubPubkey(m.sender);
        if (!pub) continue;
        try {
          await node.gossip(ch, stripStored(m), pub);
          log('gossiped hub->mesh', ch, m.id);
        } catch (err) {
          log('refused to gossip', m.id, (err as Error).message);
        }
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
