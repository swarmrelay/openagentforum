import { describe, expect, it, vi } from 'vitest';
import { generateAgentKeyPair, signEnvelope } from '@openagentforum/protocol';
import { SwarmClient } from '../src/client.js';

describe('SDK stream verify-as-stored', () => {
  it.each(['payload', 'channel', 'key', 'bootstrap'])('refuses a forged %s without acknowledging its cursor', async (attack) => {
    const keys = await generateAgentKeyPair();
    const other = await generateAgentKeyPair();
    const signed = await signEnvelope({ channel: 'general', sender: keys.agentId, type: 'intel', payload: { insight: 'original' } }, keys.signingPrivateKey);
    const envelope = { ...signed, storedSeq: 1 };
    if (attack === 'payload' || attack === 'bootstrap') envelope.payload.insight = 'forged';
    if (attack === 'channel') envelope.channel = 'another-channel';
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/agents/')) return Response.json({ agent: { publicKey: attack === 'key' ? other.signingPublicKey : keys.signingPublicKey } });
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [envelope] });
      return new Response(`id: 1\nevent: envelope\ndata: ${JSON.stringify(envelope)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, fetch: fetcher });
    const receive = vi.fn();
    const onError = vi.fn();
    const stop = client.subscribe('general', receive, { ...(attack === 'bootstrap' ? {} : { after: 0 }), retryMs: 250, onError });
    try {
      await vi.waitFor(() => expect(onError.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(receive).not.toHaveBeenCalled();
      const streams = fetcher.mock.calls.map(([url]) => new URL(String(url))).filter(url => url.pathname.endsWith('/stream'));
      if (attack === 'bootstrap') expect(streams).toHaveLength(0);
      else expect(streams.every(url => url.searchParams.get('after') === '0')).toBe(true);
    } finally { stop(); }
  });

  it('verifies an honest envelope and escapes channel paths for reads and writes', async () => {
    const keys = await generateAgentKeyPair();
    const channel = 'topic/with?query#fragment';
    const signed = await signEnvelope({ channel, sender: keys.agentId, type: 'intel', payload: { insight: 'original' } }, keys.signingPrivateKey);
    const envelope = { ...signed, storedSeq: 1 };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/agents/')) return Response.json({ agent: { publicKey: keys.signingPublicKey } });
      if (init?.method === 'POST') return Response.json({ envelope });
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [envelope] });
      return new Response(`id: 1\nevent: envelope\ndata: ${JSON.stringify(envelope)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, fetch: fetcher });
    await client.getMessages(channel);
    await client.postMessage({ channel, type: 'intel', payload: { insight: 'test' }, sequence: 0 });
    const receive = vi.fn();
    const stop = client.subscribe(channel, receive, { after: 0 });
    try {
      await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
      expect(receive.mock.calls[0][0].data).toEqual(envelope);
      const paths = fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname).filter(path => path.includes('/channels/'));
      expect(paths).toHaveLength(3);
      expect(paths.every(path => path.startsWith(`/v1/channels/${encodeURIComponent(channel)}/`))).toBe(true);
    } finally { stop(); }
  });
});
