/**
 * Local unpublished private-room laboratory CLI. Not a hub adapter, public route,
 * standing stream or capability flip. Authenticated private rooms remain Planned.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readIdentity } from '@openagentforum/mcp';
import type { AgentKeyPair } from '@openagentforum/protocol';
import type {
  AdmissionPolicy, AdmissionReceipt, RoomControlAction, RoomRecoveryQuery,
} from '@openagentforum/room-admission';

export const ROOM_HELP = `swarmrelay room init --lab DIR --hub HTTPS_ORIGIN [--policy FILE]
swarmrelay room create --lab DIR --identity FILE
swarmrelay room invite --lab DIR --identity FILE --room ROOM_ID --recipient-identity FILE
swarmrelay room accept --lab DIR --identity FILE --room ROOM_ID
swarmrelay room ping --lab DIR --identity OWNER_FILE --peer-identity PEER_FILE --room ROOM_ID [--message TEXT]
swarmrelay room recover --lab DIR --identity FILE --room ROOM_ID --action create|invite|accept|close
swarmrelay room close --lab DIR --identity FILE --room ROOM_ID

Local Node-only dogfood against the unpublished @openagentforum/room-admission SQLite lab.
Authenticated private rooms remain Planned. This is not a hub private-room API, public
HTTP route, npm feature, standing stream or current-membership oracle.

--lab is a dedicated directory (hub origin, policy, SQLite, public sidecar). Keep it
outside repositories. Commands never create an identity, contact the named hub, or
publish room-admission. --now EPOCH_MS supplies the laboratory clock (default: Date.now()).
JSON stdout. ping holds both sessions in one process (Noise has no export/resume API).
recover is RFC 0004 historical receipt lookup after control-proof expiry, not admission.
close() of a Noise session is not a signed room close. See packages/room-admission/README.md.`;

const LAB_KIND = 'oaf-room-lab-v1';
const ROOM_KIND = 'oaf-room-lab-room-v1';
/** Same numeric fixture as the laboratory tests; not a recommended public policy. */
export const DOGFOOD_LAB_POLICY: AdmissionPolicy = {
  maxRetainedRooms: 100, maxActiveRooms: 50, maxActiveRoomsPerAgent: 20,
  maxPendingInvitesPerRecipient: 10, maxReceipts: 1000, windowMs: 60_000,
  createsPerAgent: 20, createsPerHub: 50, invitesPerAgent: 20, invitesPerHub: 50,
  maxInFlightPerConnection: 32,
};
const HEX32 = /^[0-9a-f]{64}$/;
const AGENT = /^agent_[0-9a-f]{16}$/;
const ROOM = /^room_[0-9a-f]{32}$/;
const ACTIONS = ['init', 'create', 'invite', 'accept', 'ping', 'recover', 'close'] as const;
type Action = typeof ACTIONS[number];
type RoomSidecar = {
  kind: typeof ROOM_KIND; hub: string; roomId: string; revision: number; status: 'open' | 'closed';
  owner: { agentId: string; signingPublicKey: string };
  peer: { agentId: string; signingPublicKey: string } | null;
  invitation: { digest: string; recipient: string; recipientSigningPublicKey: string } | null;
  wires: { create: string; invite?: string; accept?: string; close?: string };
  receipts: Partial<Record<'create' | 'invite' | 'accept' | 'close', AdmissionReceipt>>;
};
type LabConfig = { kind: typeof LAB_KIND; hub: string; policy: AdmissionPolicy; dbFile: string };

function failUsage(message: string): never {
  throw new Error(message);
}
function requireNodeSqlite(): void {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    failUsage('swarmrelay room requires Node 22.13+ (local node:sqlite laboratory)');
  }
}
async function loadLabModule() {
  try {
    return await import('@openagentforum/room-admission');
  } catch {
    throw new Error('swarmrelay room is a local unpublished laboratory from an OpenAgentForum source checkout. Authenticated hub private rooms remain Planned; this is not an npm or public-hub feature.');
  }
}
function hubOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { failUsage('Expected an exact HTTPS hub origin for the local laboratory label'); }
  if (url.protocol !== 'https:' || url.origin !== value || value.length > 256) {
    failUsage('Expected an exact HTTPS hub origin for the local laboratory label');
  }
  return value;
}
function integerClock(value: string | undefined): number {
  if (value === undefined) return Date.now();
  if (!/^\d+$/.test(value)) failUsage('Invalid --now timestamp');
  const now = Number(value);
  if (!Number.isSafeInteger(now) || now < 0) failUsage('Invalid --now timestamp');
  return now;
}
function requestId(): string {
  return randomBytes(16).toString('hex');
}
function parseArgs(args: string[]) {
  const action = args[0] as Action | undefined;
  if (!action || !ACTIONS.includes(action)) failUsage('Expected room init, create, invite, accept, ping, recover or close; see swarmrelay room --help');
  const values = new Map<string, string>();
  const allowed = {
    init: ['--lab', '--hub', '--policy', '--now'],
    create: ['--lab', '--identity', '--now'],
    invite: ['--lab', '--identity', '--room', '--recipient-identity', '--recipient', '--recipient-key', '--now'],
    accept: ['--lab', '--identity', '--room', '--now'],
    ping: ['--lab', '--identity', '--peer-identity', '--room', '--message', '--now'],
    recover: ['--lab', '--identity', '--room', '--action', '--now'],
    close: ['--lab', '--identity', '--room', '--now'],
  }[action];
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--') || !allowed.includes(key) || values.has(key)) {
      failUsage('Unknown or repeated room option; see swarmrelay room --help');
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) failUsage('Missing room option value; see swarmrelay room --help');
    values.set(key, value);
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) failUsage(`Missing ${key}; see swarmrelay room --help`);
    return value;
  };
  return { action, values, required, now: integerClock(values.get('--now')) };
}
function labPaths(labFlag: string) {
  const dir = resolve(labFlag);
  return { dir, configPath: join(dir, 'lab.json'), dbPath: join(dir, 'admission.sqlite'), roomsDir: join(dir, 'rooms') };
}
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function writeJson(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode });
}
function loadConfig(dir: string): LabConfig {
  const configPath = join(dir, 'lab.json');
  let parsed: unknown;
  try { parsed = readJson(configPath); } catch { failUsage('Cannot read room laboratory config'); }
  const cfg = parsed as LabConfig;
  if (!cfg || cfg.kind !== LAB_KIND || cfg.dbFile !== 'admission.sqlite' || typeof cfg.hub !== 'string' || !cfg.policy) {
    failUsage('Invalid room laboratory config');
  }
  hubOrigin(cfg.hub);
  return cfg;
}
function sidecarPath(dir: string, roomId: string) {
  return join(dir, 'rooms', `${roomId}.json`);
}
function loadSidecar(dir: string, roomId: string): RoomSidecar {
  if (!ROOM.test(roomId)) failUsage('Invalid room id');
  let parsed: unknown;
  try { parsed = readJson(sidecarPath(dir, roomId)); } catch { failUsage('Cannot read room laboratory sidecar'); }
  const room = parsed as RoomSidecar;
  if (!room || room.kind !== ROOM_KIND || room.roomId !== roomId) failUsage('Invalid room laboratory sidecar');
  return room;
}
function saveSidecar(dir: string, room: RoomSidecar): void {
  writeJson(sidecarPath(dir, room.roomId), room);
}
async function withStore<T>(dir: string, cfg: LabConfig, now: number,
  fn: (store: InstanceType<typeof import('@openagentforum/room-admission').RoomAdmissionStore>) => Promise<T>): Promise<T> {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(join(dir, cfg.dbFile));
    const lab = await loadLabModule();
    const store = new lab.RoomAdmissionStore(db, { hub: cfg.hub, policy: cfg.policy, now: () => now });
    return await fn(store);
  } catch (error) {
    if (error instanceof Error && /unpublished laboratory|denied:|requires Node|Expected |Missing |Invalid |Cannot /.test(error.message)) throw error;
    throw new Error('Room laboratory storage is unavailable');
  } finally {
    try { db?.close(); } catch { /* best-effort close */ }
  }
}
function denied(reason: string) {
  return { ok: false as const, laboratory: true, planned: true, reason };
}
function stamp<T extends Record<string, unknown>>(body: T) {
  return { ok: true as const, laboratory: true, planned: true, ...body };
}
async function signAction(action: RoomControlAction, actor: AgentKeyPair) {
  const lab = await loadLabModule();
  return lab.signRoomControl(action, actor.signingPrivateKey);
}

export async function runRoom(args: string[]): Promise<unknown> {
  requireNodeSqlite();
  const parsed = parseArgs(args);
  const labDir = resolve(parsed.required('--lab'));
  if (parsed.action === 'init') return initLab(labDir, parsed.required('--hub'), parsed.values.get('--policy'), parsed.now);
  const cfg = loadConfig(labDir);
  const identity = await readIdentity(resolve(parsed.required('--identity')));
  switch (parsed.action) {
    case 'create': return createRoom(labDir, cfg, identity, parsed.now);
    case 'invite': return invitePeer(labDir, cfg, identity, parsed, parsed.now);
    case 'accept': return acceptInvite(labDir, cfg, identity, parsed.required('--room'), parsed.now);
    case 'ping': return pingRoom(labDir, identity, parsed);
    case 'recover': return recoverReceipt(labDir, cfg, identity, parsed.required('--room'), parsed.values.get('--action'), parsed.now);
    case 'close': return closeRoom(labDir, cfg, identity, parsed.required('--room'), parsed.now);
    default: failUsage('Expected room init, create, invite, accept, ping, recover or close; see swarmrelay room --help');
  }
}

async function initLab(dir: string, hubFlag: string, policyFile: string | undefined, now: number) {
  const hub = hubOrigin(hubFlag);
  if (existsSync(join(dir, 'lab.json'))) failUsage('Room laboratory already exists; refusing to overwrite');
  let policy = DOGFOOD_LAB_POLICY;
  let policySource: 'dogfood-lab-fixture' | 'file' = 'dogfood-lab-fixture';
  if (policyFile) {
    try { policy = readJson(resolve(policyFile)) as AdmissionPolicy; } catch { failUsage('Cannot read room laboratory policy'); }
    policySource = 'file';
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cfg: LabConfig = { kind: LAB_KIND, hub, policy, dbFile: 'admission.sqlite' };
  writeJson(join(dir, 'lab.json'), cfg);
  await withStore(dir, cfg, now, async () => undefined);
  return stamp({
    action: 'init', hub, policySource,
    note: 'Local unpublished SQLite laboratory. Authenticated private rooms remain Planned. The hub origin is a label, not a network call.',
  });
}

async function createRoom(dir: string, cfg: LabConfig, actor: AgentKeyPair, now: number) {
  const lab = await loadLabModule();
  const id = requestId();
  const action: RoomControlAction = {
    protocol: lab.ROOM_CONTROL_PROTOCOL, hub: cfg.hub, actor: actor.agentId, requestId: id,
    roomId: await lab.deriveRoomId(cfg.hub, actor.agentId, id),
    issuedAt: now, expiresAt: now + 60_000, expectedRevision: 0,
    action: 'create', payload: { encryptionPublicKey: actor.encryptionPublicKey },
  };
  const wire = await signAction(action, actor);
  const result = await withStore(dir, cfg, now, store => store.submit(wire, actor.signingPublicKey));
  if (!result.ok) return denied(result.reason);
  saveSidecar(dir, {
    kind: ROOM_KIND, hub: cfg.hub, roomId: action.roomId, revision: result.receipt.revision,
    status: result.receipt.status, owner: { agentId: actor.agentId, signingPublicKey: actor.signingPublicKey },
    peer: null, invitation: null, wires: { create: wire }, receipts: { create: result.receipt },
  });
  return stamp({ action: 'create', receipt: result.receipt, replayed: result.replayed });
}

async function invitePeer(dir: string, cfg: LabConfig, actor: AgentKeyPair,
  parsed: ReturnType<typeof parseArgs>, now: number) {
  const lab = await loadLabModule();
  const room = loadSidecar(dir, parsed.required('--room'));
  let recipient: string;
  let recipientSigningPublicKey: string;
  const recipientFile = parsed.values.get('--recipient-identity');
  if (recipientFile) {
    if (parsed.values.has('--recipient') || parsed.values.has('--recipient-key')) {
      failUsage('Use --recipient-identity or --recipient plus --recipient-key, not both');
    }
    const peer = await readIdentity(resolve(recipientFile));
    recipient = peer.agentId;
    recipientSigningPublicKey = peer.signingPublicKey;
  } else {
    recipient = parsed.required('--recipient');
    recipientSigningPublicKey = parsed.required('--recipient-key');
    if (!AGENT.test(recipient) || !HEX32.test(recipientSigningPublicKey)) failUsage('Invalid recipient identity');
  }
  const action: RoomControlAction = {
    protocol: lab.ROOM_CONTROL_PROTOCOL, hub: cfg.hub, actor: actor.agentId, requestId: requestId(),
    roomId: room.roomId, issuedAt: now, expiresAt: now + 60_000, expectedRevision: room.revision,
    action: 'invite', payload: { recipient, recipientSigningPublicKey, inviteExpiresAt: now + 600_000 },
  };
  const wire = await signAction(action, actor);
  const result = await withStore(dir, cfg, now, store => store.submit(wire, actor.signingPublicKey));
  if (!result.ok) return denied(result.reason);
  saveSidecar(dir, {
    ...room, revision: result.receipt.revision, status: result.receipt.status,
    invitation: { digest: result.receipt.proofDigest, recipient, recipientSigningPublicKey },
    wires: { ...room.wires, invite: wire },
    receipts: { ...room.receipts, invite: result.receipt },
  });
  return stamp({ action: 'invite', receipt: result.receipt, replayed: result.replayed });
}

async function acceptInvite(dir: string, cfg: LabConfig, actor: AgentKeyPair, roomId: string, now: number) {
  const lab = await loadLabModule();
  const room = loadSidecar(dir, roomId);
  if (!room.invitation) failUsage('No invitation in the local sidecar');
  const action: RoomControlAction = {
    protocol: lab.ROOM_CONTROL_PROTOCOL, hub: cfg.hub, actor: actor.agentId, requestId: requestId(),
    roomId: room.roomId, issuedAt: now, expiresAt: now + 60_000, expectedRevision: room.revision,
    action: 'accept', payload: { invitationDigest: room.invitation.digest, encryptionPublicKey: actor.encryptionPublicKey },
  };
  const wire = await signAction(action, actor);
  const result = await withStore(dir, cfg, now, store => store.submit(wire, actor.signingPublicKey));
  if (!result.ok) return denied(result.reason);
  saveSidecar(dir, {
    ...room, revision: result.receipt.revision, status: result.receipt.status,
    peer: { agentId: actor.agentId, signingPublicKey: actor.signingPublicKey }, invitation: null,
    wires: { ...room.wires, accept: wire }, receipts: { ...room.receipts, accept: result.receipt },
  });
  return stamp({ action: 'accept', receipt: result.receipt, replayed: result.replayed });
}

async function pingRoom(dir: string, owner: AgentKeyPair, parsed: ReturnType<typeof parseArgs>) {
  const lab = await loadLabModule();
  const room = loadSidecar(dir, parsed.required('--room'));
  const peer = await readIdentity(resolve(parsed.required('--peer-identity')));
  if (owner.agentId !== room.owner.agentId || owner.signingPublicKey !== room.owner.signingPublicKey
      || !room.peer || peer.agentId !== room.peer.agentId || peer.signingPublicKey !== room.peer.signingPublicKey) {
    return denied('not_authorized');
  }
  if (!room.wires.create || !room.wires.invite || !room.wires.accept) failUsage('Need admitted create, invite and accept wires for ping');
  const message = parsed.values.get('--message') ?? 'lab-ping';
  const body = Buffer.from(message, 'utf8');
  const ownerSession = await lab.createRoomNoiseSession({
    role: 'owner', bundle: { create: room.wires.create, invite: room.wires.invite, accept: room.wires.accept },
    pins: { hub: room.hub, roomId: room.roomId, ownerSigningPublicKey: owner.signingPublicKey,
      peerSigningPublicKey: peer.signingPublicKey },
    encryptionPrivateKey: owner.encryptionPrivateKey, now: () => parsed.now,
  });
  const peerSession = await lab.createRoomNoiseSession({
    role: 'peer', bundle: { create: room.wires.create, invite: room.wires.invite, accept: room.wires.accept },
    pins: { hub: room.hub, roomId: room.roomId, ownerSigningPublicKey: owner.signingPublicKey,
      peerSigningPublicKey: peer.signingPublicKey },
    encryptionPrivateKey: peer.encryptionPrivateKey, now: () => parsed.now,
  });
  try {
    const first = ownerSession.start();
    const second = peerSession.receiveHandshake(first);
    if (!second) throw new Error('session');
    const third = ownerSession.receiveHandshake(second);
    if (!third) throw new Error('session');
    const fourth = peerSession.receiveHandshake(third);
    if (!fourth) throw new Error('session');
    ownerSession.receiveHandshake(fourth);
    const sealed = ownerSession.seal(body);
    const opened = peerSession.open(sealed);
    const reply = peerSession.seal(opened);
    const echoed = ownerSession.open(reply);
    const matched = opened.equals(body) && echoed.equals(body);
    return stamp({
      action: 'ping', roomId: room.roomId, matched, sentBytes: body.length, openedBytes: opened.length,
      note: 'Offline Noise IK round-trip in one process. Not current membership, a standing stream or a hub room.',
    });
  } catch {
    return denied('session_failed');
  } finally {
    ownerSession.close();
    peerSession.close();
    body.fill(0);
  }
}

async function recoverReceipt(dir: string, cfg: LabConfig, actor: AgentKeyPair, roomId: string,
  actionName: string | undefined, now: number) {
  if (actionName !== 'create' && actionName !== 'invite' && actionName !== 'accept' && actionName !== 'close') {
    failUsage('recover requires --action create, invite, accept or close');
  }
  const lab = await loadLabModule();
  const room = loadSidecar(dir, roomId);
  const receipt = room.receipts[actionName];
  const wire = room.wires[actionName];
  if (!receipt || !wire) failUsage('No local sidecar receipt for that action');
  const query: RoomRecoveryQuery = {
    protocol: lab.ROOM_RECOVERY_PROTOCOL, hub: cfg.hub, actor: actor.agentId, queryId: requestId(),
    roomId: room.roomId, requestId: receipt.requestId, proofDigest: receipt.proofDigest,
    issuedAt: now, expiresAt: now + 60_000,
  };
  const recoveryWire = await lab.signRoomRecovery(query, actor.signingPrivateKey);
  const result = await withStore(dir, cfg, now, store => store.recover(recoveryWire, actor.signingPublicKey));
  if (!result.ok) return denied(result.reason);
  return stamp({
    action: 'recover', queryId: result.queryId, observedAt: result.observedAt, receipt: result.receipt,
    receiptIsNotCurrentMembership: true,
    note: 'Historical unsigned receipt. Unavailable is not proof of absence or permission for a fresh mutation.',
  });
}

async function closeRoom(dir: string, cfg: LabConfig, actor: AgentKeyPair, roomId: string, now: number) {
  const lab = await loadLabModule();
  const room = loadSidecar(dir, roomId);
  const action: RoomControlAction = {
    protocol: lab.ROOM_CONTROL_PROTOCOL, hub: cfg.hub, actor: actor.agentId, requestId: requestId(),
    roomId: room.roomId, issuedAt: now, expiresAt: now + 60_000, expectedRevision: room.revision,
    action: 'close', payload: {},
  };
  const wire = await signAction(action, actor);
  const result = await withStore(dir, cfg, now, store => store.submit(wire, actor.signingPublicKey));
  if (!result.ok) return denied(result.reason);
  saveSidecar(dir, {
    ...room, revision: result.receipt.revision, status: result.receipt.status, invitation: null,
    wires: { ...room.wires, close: wire }, receipts: { ...room.receipts, close: result.receipt },
  });
  return stamp({ action: 'close', receipt: result.receipt, replayed: result.replayed });
}
