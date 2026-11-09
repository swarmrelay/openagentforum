import { describe, expect, it, vi } from 'vitest';
import { fetchProfileName, resolvePostingName } from '../src/identity-name.js';

const agentId = 'agent_0123456789abcdef';
const file = '/home/agent/.swarmrelay/identity.json';

describe('shared-identity name check', () => {
  it('uses the explicit or default name for a key with no registered profile', () => {
    expect(resolvePostingName({ agentId, file, explicitName: 'Onyx', profileName: null })).toEqual({ action: 'ok', name: 'Onyx' });
    expect(resolvePostingName({ agentId, file, profileName: null })).toEqual({ action: 'ok', name: 'Agent-012345' });
  });

  it('labels posts with the registered name when --name is omitted or matches', () => {
    expect(resolvePostingName({ agentId, file, profileName: 'Reed' })).toEqual({ action: 'ok', name: 'Reed' });
    expect(resolvePostingName({ agentId, file, explicitName: ' reed ', profileName: 'Reed' })).toEqual({ action: 'ok', name: 'Reed' });
  });

  it('refuses a different --name on a key registered under another custom name', () => {
    const result = resolvePostingName({ agentId, file, explicitName: 'Onyx', profileName: 'Reed' });
    expect(result.action).toBe('refuse');
    if (result.action === 'refuse') {
      expect(result.message).toContain('"Reed"');
      expect(result.message).toContain('--identity');
      expect(result.message).toContain('SWARM_IDENTITY');
      expect(result.message).toContain(file);
    }
  });

  it('only warns when the registered name is still the default', () => {
    const result = resolvePostingName({ agentId, file, explicitName: 'Onyx', profileName: 'Agent-012345' });
    expect(result).toMatchObject({ action: 'warn', name: 'Onyx' });
  });
});

describe('profile name lookup', () => {
  const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('returns the name of a signed profile and null otherwise', async () => {
    expect(await fetchProfileName('https://hub.test', agentId, respond(200, { revision: 3, agent: { name: 'Reed' } }))).toBe('Reed');
    expect(await fetchProfileName('https://hub.test', agentId, respond(200, { revision: 0, agent: null }))).toBeNull();
    expect(await fetchProfileName('https://hub.test', agentId, respond(200, { revision: 0, agent: { name: 'Agent-012345' } }))).toBeNull();
    expect(await fetchProfileName('https://hub.test', agentId, respond(503, {}))).toBeNull();
    expect(await fetchProfileName('https://hub.test', agentId, vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });

  it('reads the registration state endpoint for this key', async () => {
    const fetchImpl = respond(200, { revision: 1, agent: { name: 'Reed' } });
    await fetchProfileName('https://hub.test', agentId, fetchImpl);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(`https://hub.test/v1/agents/${agentId}/registration`);
  });
});
