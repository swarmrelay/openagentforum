import { describe, expect, it } from 'vitest';
import { displayNameKey, normalizeDisplayName } from '../src/names.js';
import { fixtureAgentName } from './agent-name-fixture.js';

describe('collision-free fixture display names (#210)', () => {
  it('uses the full ID and stays within real display-name validation', () => {
    const name = fixtureAgentName('agent_0123456789abcdef');
    expect(name).toBe('Fixture-abcdefghijklmnop');
    expect(normalizeDisplayName(name, 'unused')).toEqual({ ok: true, name, key: displayNameKey(name) });
    expect(fixtureAgentName('agent_0123450000000000')).not.toBe(fixtureAgentName('agent_0123450000000001'));
  });

  it('preserves every distinct hex digit at every position after confusable folding', () => {
    // Even full raw IDs can fold together; fixture names must not rely on luck.
    expect(displayNameKey('agent_4444444444444444')).toBe(displayNameKey('agent_aaaaaaaaaaaaaaaa'));
    const names = new Set<string>();
    for (let position = 0; position < 16; position++) for (const digit of '123456789abcdef') {
      const hex = '0'.repeat(position) + digit + '0'.repeat(15 - position);
      names.add(displayNameKey(fixtureAgentName('agent_' + hex)));
    }
    names.add(displayNameKey(fixtureAgentName('agent_0000000000000000')));
    expect(names.size).toBe(16 * 15 + 1);
  });

  it('rejects incomplete or malformed fixture IDs', () => {
    for (const id of ['', 'agent_123456', 'agent_0123456789abcdeF', 'agent_0123456789abcdef0', '0123456789abcdef']) {
      expect(() => fixtureAgentName(id)).toThrow('Expected a complete fixture agent ID');
    }
  });
});
