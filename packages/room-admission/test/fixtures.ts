import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAgentKeyPair, type AgentKeyPair } from '@openagentforum/protocol';
import { deriveRoomId, ROOM_CONTROL_PROTOCOL, signRoomControl, type RoomControlAction, type RoomState } from '../src/control.js';
import { RoomAdmissionStore, type AdmissionPolicy, type AdmissionResult } from '../src/sqlite.js';

export const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export const HUB = 'https://relay.example.com';
export const START = 1_800_000_000_000;
export const POLICY: AdmissionPolicy = {
  maxRetainedRooms: 100, maxActiveRooms: 50, maxActiveRoomsPerAgent: 20,
  maxPendingInvitesPerRecipient: 10, maxReceipts: 1000, windowMs: 60_000,
  createsPerAgent: 20, createsPerHub: 50, invitesPerAgent: 20, invitesPerHub: 50,
  maxInFlightPerConnection: 32,
};
let counter = 0;
export async function actionFor(actor: AgentKeyPair, kind: RoomControlAction['action'], at = START,
  state?: RoomState, recipient?: AgentKeyPair): Promise<RoomControlAction> {
  const requestId = (++counter).toString(16).padStart(32, '0');
  const base = { protocol: ROOM_CONTROL_PROTOCOL, hub: HUB, actor: actor.agentId, requestId,
    roomId: state?.roomId ?? await deriveRoomId(HUB, actor.agentId, requestId),
    issuedAt: at, expiresAt: at + 60_000, expectedRevision: state?.revision ?? 0 };
  switch (kind) {
    case 'create': return { ...base, action: kind, payload: { encryptionPublicKey: actor.encryptionPublicKey } };
    case 'invite': {
      if (!recipient) throw new Error('Test recipient missing');
      return { ...base, action: kind, payload: { recipient: recipient.agentId,
        recipientSigningPublicKey: recipient.signingPublicKey, inviteExpiresAt: at + 600_000 } };
    }
    case 'accept': return { ...base, action: kind, payload: { invitationDigest: state!.invitation!.digest,
      encryptionPublicKey: actor.encryptionPublicKey } };
    case 'close': return { ...base, action: kind, payload: {} };
  }
}
export function admitted(result: AdmissionResult) {
  if (!result.ok) throw new Error(`Admission failed: ${result.reason}`);
  return result;
}
export async function fixture(patch: Partial<AdmissionPolicy> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'oaf-room-admission-'));
  const path = join(directory, 'admission.sqlite');
  const policy = { ...POLICY, ...patch };
  const clock = { now: START };
  let db = new DatabaseSync(path);
  const options = { hub: HUB, policy, now: () => clock.now };
  let store = new RoomAdmissionStore(db, options);
  const [owner, peer, outsider] = await Promise.all([
    generateAgentKeyPair(), generateAgentKeyPair(), generateAgentKeyPair(),
  ]);
  const room = (roomId: string): RoomState => {
    const row = db.prepare('SELECT state_json FROM room_lab_rooms WHERE room_id = ?').get(roomId) as { state_json: string };
    return JSON.parse(row.state_json);
  };
  const wire = (action: RoomControlAction, actor = owner) => signRoomControl(action, actor.signingPrivateKey);
  const submit = async (action: RoomControlAction, actor = owner) => store.submit(await wire(action, actor), actor.signingPublicKey);
  const create = async (actor = owner) => {
    const action = await actionFor(actor, 'create', clock.now);
    const result = admitted(await submit(action, actor));
    return { action, result, state: room(action.roomId) };
  };
  const invite = async (state: RoomState, recipient = peer, actor = owner) => {
    const action = await actionFor(actor, 'invite', clock.now, state, recipient);
    const result = admitted(await submit(action, actor));
    return { action, result, state: room(state.roomId) };
  };
  const counts = () => ({
    rooms: (db.prepare('SELECT count(*) AS n FROM room_lab_rooms').get() as { n: number }).n,
    receipts: (db.prepare('SELECT count(*) AS n FROM room_lab_receipts').get() as { n: number }).n,
    budgets: db.prepare('SELECT * FROM room_lab_budgets ORDER BY scope, kind, bucket').all(),
  });
  return {
    get db() { return db; }, get store() { return store; }, path, directory, policy, options, clock,
    owner, peer, outsider, room, wire, submit, create, invite, counts,
    restart() { db.close(); db = new DatabaseSync(path); store = new RoomAdmissionStore(db, options); },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
