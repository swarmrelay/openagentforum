// Test-only, fixed diagnostics. Never forward raw errors, peer data, keys or paths.
const phases = ['initialize', 'discover-peer', 'start-setup', 'wait-peer', 'offer', 'accept', 'session',
  'owner-data', 'owner-recovery', 'peer-data', 'peer-close'];
const codes = ['ERR_ASSERTION', 'invalid_input', 'wrong_phase', 'busy', 'unavailable', 'needs_recovery', 'deadline',
  'disposed', 'invalid_request', 'room_unavailable', 'room_rate_limited', 'room_request_unavailable',
  'room_outcome_unknown', 'room_invalid_response', 'room_transport_unknown', 'request_timeout'];
const operations = ['directory', 'forum-read', 'forum-post', 'control', 'recovery', 'state',
  'packets-write', 'packets-read', 'packets-recovery'];
const pick = (value, allowed) => allowed.includes(value) ? value : 'unknown';
const storageStages = ['before-storage', 'sender-key', 'channel-policy', 'message-replay', 'channel-create',
  'message-sequence', 'message-insert', 'channel-metadata', 'agent-metadata', 'lookup', 'none'];
const storageErrors = ['none', 'unique', 'busy', 'constraint', 'overload', 'io-context', 'connection-lost', 'd1', 'other'];
export const ROOM_STORAGE_HEADER = 'x-oaf-fixture-storage';
export function roomStorageDiagnostic(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { last: pick(v.last, storageStages), failed: pick(v.failed, storageStages), error: pick(v.error, storageErrors) };
}
export function roomStorageFromHeader(raw) {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  try {
    const value = JSON.parse(raw), safe = roomStorageDiagnostic(value);
    return JSON.stringify(safe) === JSON.stringify(value) ? safe : null;
  } catch { return null; }
}
export function roomDiagnostic(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { role: pick(v.role, ['owner', 'peer']), mode: pick(v.mode, ['single', 'pause', 'return']),
    phase: pick(v.phase, phases), code: pick(v.code, codes), operation: pick(v.operation, operations),
    status: Number.isInteger(v.status) && v.status >= 100 && v.status <= 599 ? v.status : null,
    ...(v.storage === undefined ? {} : { storage: roomStorageDiagnostic(v.storage) }) };
}
const prefix = 'OAF_ROOM_FAILURE ';
export const roomFailureLine = value => prefix + JSON.stringify(roomDiagnostic(value));
/** Parse only the bounded fixture marker, never print arbitrary subprocess output. */
export function roomFailureFromOutput(output) {
  if (typeof output !== 'string' || output.length > 262144) return null;
  for (const raw of output.split('\n')) {
    const line = raw.startsWith('# ') ? raw.slice(2) : raw;
    if (!line.startsWith(prefix) || line.length > 1024) continue;
    try {
      const value = JSON.parse(line.slice(prefix.length));
      // Reject altered/extra fields, not just the unsafe field's value.
      if (JSON.stringify(roomDiagnostic(value)) === JSON.stringify(value)) return roomFailureLine(value);
    } catch { /* no raw parse diagnostics */ }
  }
  return null;
}
