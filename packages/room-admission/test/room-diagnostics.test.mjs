import { describe, it, expect } from 'vitest';
import { roomDiagnostic, roomFailureLine, roomFailureFromOutput } from './fixtures/room-diagnostics.mjs';

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
});
