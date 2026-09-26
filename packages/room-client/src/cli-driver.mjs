// A trusted local command interface around the existing client, never a peer command interpreter.
import { isAbsolute } from 'node:path';

export class CommandError extends Error {
  constructor(code = 'invalid_input') { super(code); this.code = code; }
}
const invalid = () => { throw new CommandError(); };
function shape(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(value);
const room = value => typeof value === 'string' && /^room_[0-9a-f]{32}$/.test(value);
const channel = value => typeof value === 'string' && /^room-setup-[0-9a-f]{32}$/.test(value);
function configuration(value, initialize) {
  shape(value, ['directory', 'hub', initialize ? 'signingPrivateKey' : 'signingPublicKey', 'policy', ...(initialize ? [] : ['op'])]);
  if (typeof value.directory !== 'string' || !isAbsolute(value.directory) || value.directory.length > 4096
    || /[\u0000-\u001f\u007f]/.test(value.directory)) invalid();
  let url; try { url = new URL(value.hub); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.origin !== value.hub || url.username || url.password) invalid();
  if (initialize ? typeof value.signingPrivateKey !== 'string' || !/^(?:[0-9a-f]{2}){1,256}$/.test(value.signingPrivateKey)
    : !hex(value.signingPublicKey, 64)) invalid();
  const maxima = { rooms: 1000, sessions: 10000, controls: 10000, packets: 65536, packetBytes: 67108864, setups: 1000, setupBytes: 33554432 };
  shape(value.policy, Object.keys(maxima));
  for (const [key, max] of Object.entries(maxima)) {
    if (!Number.isSafeInteger(value.policy[key]) || value.policy[key] < 1 || value.policy[key] > max) invalid();
  }
}
export function initialize(api, value) {
  configuration(value, true);
  let local;
  try {
    local = api.RoomLocalState.initialize(value.directory, { hub: value.hub, signingPrivateKey: value.signingPrivateKey, policy: value.policy });
    return { kind: 'local-room-state', ...local.scope() };
  } finally { local?.close(); }
}
const reference = value => {
  shape(value, ['kind', 'roomId', 'requestId']);
  if (!['control', 'packet'].includes(value.kind) || !room(value.roomId) || !hex(value.requestId, 32)) invalid();
  return { kind: value.kind, roomId: value.roomId, requestId: value.requestId };
};
export function safeError(api, error) {
  const codes = ['invalid_input', 'wrong_phase', 'busy', 'unavailable', 'needs_recovery', 'deadline', 'disposed'];
  const recognized = error instanceof CommandError || error instanceof api.RoomClientError;
  const code = recognized && codes.includes(error.code) ? error.code
    : error instanceof api.RoomLocalStateError ? 'local_state_unavailable' : 'unavailable';
  let recovery = null;
  if (error instanceof api.RoomClientError && error.recovery) {
    try { recovery = reference(error.recovery); } catch { /* No unvalidated diagnostic fields. */ }
  }
  return { code, permitsReplacementMutation: false, recovery };
}

export function createCommandSession(api) {
  let local, client, disposed = false;
  const requireLocal = () => { if (!local || disposed) throw new CommandError('wrong_phase'); return local; };
  const requireClient = () => { requireLocal(); if (!client) throw new CommandError('wrong_phase'); return client; };
  return {
    snapshot: () => ({ phase: disposed ? 'disposed' : client?.phase ?? (local ? 'open' : 'unopened'),
      roomId: client?.roomId ?? null, sessionId: client?.sessionId ?? null }),
    dispose() { if (disposed) return; disposed = true; try { client?.dispose(); } finally { local?.close(); } },
    async execute(value) {
      if (!value || typeof value.op !== 'string' || disposed) invalid();
      const empty = () => shape(value, ['op']);
      switch (value.op) {
        case 'open': {
          configuration(value, false);
          if (local) throw new CommandError('wrong_phase');
          local = api.RoomLocalState.open(value.directory, { hub: value.hub, signingPublicKey: value.signingPublicKey, policy: value.policy });
          return { kind: 'local-room-state', ...local.scope() };
        }
        case 'setup': {
          shape(value, ['op', 'peerSigningPublicKey', 'role', 'channel'], ['existingRoomId']);
          if (!hex(value.peerSigningPublicKey, 64) || !['creator', 'peer'].includes(value.role) || !channel(value.channel)
            || (Object.hasOwn(value, 'existingRoomId') && !room(value.existingRoomId))) invalid();
          requireLocal(); if (client) throw new CommandError('wrong_phase');
          client = new api.RoomClient({ local, peerSigningPublicKey: value.peerSigningPublicKey,
            role: value.role === 'creator' ? 'owner' : 'peer', channel: value.channel,
            ...(value.existingRoomId ? { existingRoomId: value.existingRoomId } : {}) });
          return null; // Construction only; start-setup is the explicit write.
        }
        case 'start-setup': empty(); await requireClient().startSetup(); return null;
        case 'wait-peer': empty(); await requireClient().waitForPeer(); return null;
        case 'invite': empty(); return requireClient().invite();
        case 'inspect': empty(); return requireClient().inspectInvitation();
        case 'accept': {
          shape(value, ['op', 'decision']);
          const decision = value.decision;
          if (!decision || !['untrusted-room-invitation', 'untrusted-room-session'].includes(decision.kind)) invalid();
          const digest = decision.kind === 'untrusted-room-invitation' ? 'invitationDigest' : 'bindingDigest';
          shape(decision, ['kind', 'roomId', 'sessionId', 'fromSigningPublicKey', digest, 'expiresAt']);
          if (!room(decision.roomId) || !hex(decision.sessionId, 32) || !hex(decision.fromSigningPublicKey, 64)
            || !hex(decision[digest], 64) || !Number.isSafeInteger(decision.expiresAt)) invalid();
          await requireClient().accept(decision); return null;
        }
        case 'wait-acceptance': empty(); await requireClient().waitForAcceptance(); return null;
        case 'connect': empty(); await requireClient().connect(); return null;
        case 'send': {
          shape(value, ['op', 'base64']);
          if (typeof value.base64 !== 'string' || value.base64.length > 21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) invalid();
          const bytes = Buffer.from(value.base64, 'base64');
          if (bytes.length > 16384 || bytes.toString('base64') !== value.base64) invalid();
          try { await requireClient().send(bytes); return null; } finally { bytes.fill(0); }
        }
        case 'receive': {
          empty(); const result = await requireClient().receive();
          if (result.kind !== 'untrusted-room-data') return { kind: result.kind };
          // Peer bytes are always encoded DATA on stdout, never command input or terminal text.
          return { kind: result.kind, roomId: result.roomId, sessionId: result.sessionId,
            senderSigningPublicKey: result.senderSigningPublicKey, requestId: result.requestId,
            base64: Buffer.from(result.bytes).toString('base64') };
        }
        case 'ack': shape(value, ['op', 'requestId']); if (!hex(value.requestId, 32)) invalid(); requireClient().acknowledge(value.requestId); return null;
        case 'recover-send': empty(); return requireClient().recoverSend();
        case 'pending': {
          shape(value, ['op'], ['after', 'limit']); const after = value.after ?? 0, limit = value.limit ?? 20;
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) invalid();
          return requireLocal().pending(after, limit);
        }
        case 'setup-attempt': {
          shape(value, ['op', 'channel']); if (!channel(value.channel)) invalid();
          const attempt = requireLocal().invitationAttempt(value.channel);
          // Do not copy raw wires/ciphertext into routine diagnostics.
          return { kind: 'historical-setup-attempt', keyReserved: attempt.keyWire !== null, sealedReserved: attempt.sealedWire !== null };
        }
        case 'recover': shape(value, ['op', 'reference']); return api.recoverRoomOperation(requireLocal(), reference(value.reference));
        case 'status': shape(value, ['op', 'roomId']); if (!room(value.roomId)) invalid(); return api.readRoomStatus(requireLocal(), value.roomId);
        case 'close': shape(value, ['op', 'roomId']); if (!room(value.roomId)) invalid(); return api.closeRoom(requireLocal(), value.roomId);
        case 'info': empty(); requireLocal(); return null;
        default: invalid();
      }
    },
  };
}
