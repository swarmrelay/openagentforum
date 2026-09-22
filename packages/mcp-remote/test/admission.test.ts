import { describe, expect, it, vi } from 'vitest';
import { createPublicMcpHandler } from '../src/index.js';
import { admitPublicMcp } from '../../../apps/web/functions/_lib/public-mcp-budget.js';

const request = () => new Request('https://connector.example/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
});
describe('host admission before parsing and tool work', () => {
  it.each([
    ['denied', () => Promise.resolve({ allowed: false, retryAfterSeconds: 60 }), 429],
    ['uncertain', () => Promise.reject(new Error('private storage error')), 503],
    ['malformed', () => Promise.resolve({ allowed: 'yes', retryAfterSeconds: NaN }), 503],
  ])('%s never falls through', async (_label, admitRequest, status) => {
    const readPublic = vi.fn();
    const admission = vi.fn(admitRequest);
    const response = await createPublicMcpHandler({ endpointOrigin: 'https://connector.example', readPublic, admitRequest: admission as any })(request());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain('private storage');
    expect(admission).toHaveBeenCalledTimes(1);
    expect(readPublic).not.toHaveBeenCalled();
  });
  it('times out once without retrying a stalled storage operation', async () => {
    vi.useFakeTimers();
    try {
      const admission = vi.fn(() => new Promise<any>(() => {}));
      const pending = createPublicMcpHandler({ endpointOrigin: 'https://connector.example', readPublic: vi.fn(), admitRequest: admission })(request());
      await vi.advanceTimersByTimeAsync(2001);
      expect((await pending).status).toBe(503);
      expect(admission).toHaveBeenCalledTimes(1);
      expect((admission.mock.calls[0] as any)[0].aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe('primary D1 admission', () => {
  it('rechecks cancellation after a possibly committed write', async () => {
    const controller = new AbortController();
    const first = vi.fn(async () => { controller.abort(); return { admitted: 1 }; });
    const db = { withSession: vi.fn(() => ({ prepare: vi.fn(() => ({ first })) })) };
    await expect(admitPublicMcp(db as any, controller.signal)).rejects.toThrow();
    expect(db.withSession).toHaveBeenCalledWith('first-primary');
    expect(first).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid storage acknowledgments', async () => {
    const db = { withSession: () => ({ prepare: () => ({ first: async () => ({ admitted: 2 }) }) }) };
    await expect(admitPublicMcp(db as any, new AbortController().signal)).rejects.toThrow('Invalid admission');
  });
});
