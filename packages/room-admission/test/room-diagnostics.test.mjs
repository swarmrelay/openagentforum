import { describe, it, expect } from 'vitest';
import { roomDiagnostic, roomFailureLine, roomFailureFromOutput, roomStorageFromHeader } from './fixtures/room-diagnostics.mjs';

describe('fixed native and packed journey diagnostics', () => {
  const safe = { role: 'peer', mode: 'return', phase: 'start-setup', code: 'unavailable', operation: 'state', status: 503 };
  it('retains only allowlisted stages, codes, operations and numeric HTTP status', () => {
    expect(roomDiagnostic(safe)).toEqual(safe);
    expect(roomFailureFromOutput('# ' + roomFailureLine(safe) + '\n')).toBe(roomFailureLine(safe));
    expect(roomFailureFromOutput(roomFailureLine(safe))).toBe(roomFailureLine(safe));
  });
  it('never forwards arbitrary exception prose, URLs, paths, keys or extra fields', () => {
    const marker = 'PRIVATE_FIXTURE_MARKER';
    const dirty = { ...safe, phase: marker, code: marker, operation: marker, status: marker, secret: marker };
    expect(roomFailureLine(dirty)).not.toContain(marker);
    expect(roomFailureFromOutput('# OAF_ROOM_FAILURE ' + JSON.stringify(dirty))).toBeNull();
    expect(roomFailureFromOutput('# OAF_ROOM_FAILURE ' + JSON.stringify({ ...safe, secret: marker }))).toBeNull();
    expect(roomFailureFromOutput('raw subprocess error ' + marker)).toBeNull();
    expect(roomFailureFromOutput('# OAF_ROOM_FAILURE {')).toBeNull();
    expect(roomFailureFromOutput('x'.repeat(262145))).toBeNull();
  });
  it('carries only fixed storage observations through the native and packed marker', () => {
    const storage = { last: 'message-insert', failed: 'message-insert', error: 'constraint' };
    expect(roomStorageFromHeader(JSON.stringify(storage))).toEqual(storage);
    const value = { ...safe, operation: 'forum-post', status: 500, storage };
    const line = roomFailureLine(value);
    expect(line.length).toBeLessThan(1024);
    expect(roomFailureFromOutput('# ' + line + '\n')).toBe(line);
  });
  it('rejects malformed, oversized and non-allowlisted storage headers or marker fields', () => {
    const storage = { last: 'message-insert', failed: 'message-insert', error: 'other' };
    for (const raw of [null, '{', 'x'.repeat(257), 'null', '[]', JSON.stringify({ ...storage, sql: 'PRIVATE_MARKER' }),
      JSON.stringify({ ...storage, last: 'PRIVATE_MARKER' }), JSON.stringify({ ...storage, failed: ['message-insert'] }),
      JSON.stringify({ ...storage, error: 'PRIVATE_MARKER' })]) expect(roomStorageFromHeader(raw)).toBeNull();
    const dirty = { ...safe, storage: { ...storage, error: 'PRIVATE_MARKER', sql: 'PRIVATE_MARKER' } };
    expect(roomFailureLine(dirty)).not.toContain('PRIVATE_MARKER');
    expect(roomFailureFromOutput('OAF_ROOM_FAILURE ' + JSON.stringify(dirty))).toBeNull();
  });
});
