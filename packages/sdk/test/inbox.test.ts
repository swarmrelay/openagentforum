import { describe, expect, it, vi } from 'vitest';
import { generateAgentKeyPair, signEnvelope, type MessageEnvelope } from '@openagentforum/protocol';
import { SwarmClient } from '../src/client.js';

async function fixture() {
  const me = await generateAgentKeyPair();
  const peer = await generateAgentKeyPair();
  const messages: Array<MessageEnvelope & { storedSeq: number }> = [];
  const append = async (who: typeof me, payload: Record<string, unknown>, extra = {}) => {
    const env = await signEnvelope({ channel: 'general', sender: who.agentId, type: 'intel', sequence: messages.length, payload, ...extra }, who.signingPrivateKey);
    messages.push({ ...env, storedSeq: messages.length + 1 });
    return env;
  };
  const own = await append(me, { message: 'a question' });
  await append(peer, { message: 'a reply', inReplyTo: own.id });
  await append(peer, { message: `Hello @${me.agentId}.` });
  await append(peer, { message: 'unsigned parent does not count' }, { replyToId: own.id });
  await append(me, { message: me.agentId, inReplyTo: own.id });
  await append(peer, { message: `${me.agentId}extra` });
  await append(peer, { ciphertext: me.agentId }, { type: 'e2ee_blob', encrypted: true });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/channels') return Response.json({ channels: [
      { name: 'general', isPrivate: false }, { name: 'vault', isPrivate: true },
    ] });
    if (url.pathname.includes('/agents/')) return Response.json({ agent: { publicKey: url.pathname.endsWith(me.agentId) ? me.signingPublicKey : peer.signingPublicKey } });
    return Response.json({ messages: messages.filter(m => m.storedSeq > Number(url.searchParams.get('after'))) });
  });
  const client = await SwarmClient.init({ hubUrl: 'https://relay.test', keyPair: me, autoRegister: false, fetch: fetcher });
  return { me, peer, messages, fetcher, client };
}

describe('returning agent inbox', () => {
  it('finds signed replies and exact mentions, pages without loss, and leaves acknowledgment to the caller', async () => {
    const { client, fetcher } = await fixture();
    const first = await client.getInbox({ limit: 1 });
    expect(first.items.map(x => x.reasons)).toEqual([['reply']]);
    expect(first.checkpoint.channels.general.after).toBe(2);
    expect(first.hasMore).toBe(true);
    const before = JSON.stringify(first.checkpoint);
    const rest = await client.getInbox({ checkpoint: first.checkpoint });
    expect(rest.items.map(x => x.reasons)).toEqual([['mention']]);
    expect(rest.hasMore).toBe(false);
    expect(JSON.stringify(first.checkpoint)).toBe(before);
    expect((await client.getInbox({ checkpoint: rest.checkpoint })).items).toEqual([]);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/vault/'))).toBe(false);
  });

  it.each(['signature', 'gap', 'channel'])('refuses a bad %s without changing the caller checkpoint', async (attack) => {
    const { client, messages } = await fixture();
    const first = await client.getInbox({ limit: 1 });
    const before = JSON.stringify(first.checkpoint);
    if (attack === 'signature') messages[2].payload = { message: 'forged' };
    if (attack === 'gap') messages.splice(2, 1);
    if (attack === 'channel') messages[2].channel = 'another';
    await expect(client.getInbox({ checkpoint: first.checkpoint })).rejects.toThrow(/verify|gap/);
    expect(JSON.stringify(first.checkpoint)).toBe(before);
  });

  it('refuses private channels, bad limits and cross-agent/hub checkpoints', async () => {
    const { client, peer } = await fixture();
    await expect(client.getInbox({ channels: ['vault'] })).rejects.toThrow('public');
    await expect(client.getInbox({ limit: 0 })).rejects.toThrow('limit');
    const { checkpoint } = await client.getInbox();
    await expect(client.getInbox({ checkpoint, agentId: peer.agentId })).rejects.toThrow('hub and agent');
    await expect(client.getInbox({ checkpoint: { ...checkpoint, hubUrl: 'https://other.test' } })).rejects.toThrow('hub and agent');
  });

  it('already rejects a substituted registry key even when that key validly signs a victim sender claim (#121)', async () => {
    const { client, me, peer, messages, fetcher } = await fixture();
    const first = await client.getInbox({ limit: 1 });
    const before = JSON.stringify(first.checkpoint);
    const attacker = await generateAgentKeyPair();
    messages[2] = { ...await signEnvelope({ channel: 'general', sender: peer.agentId, type: 'intel', sequence: 1, payload: { message: me.agentId } }, attacker.signingPrivateKey), storedSeq: 3 };
    const honest = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async input => String(input).endsWith(`/agents/${peer.agentId}`)
      ? Response.json({ agent: { publicKey: attacker.signingPublicKey } }) : honest(input));
    await expect(client.getInbox({ checkpoint: first.checkpoint })).rejects.toThrow('does not match public key fingerprint');
    expect(JSON.stringify(first.checkpoint)).toBe(before);
  });

  it('declares the first recent-history boundary but refuses missing history when explicitly requested', async () => {
    const { client, messages } = await fixture();
    messages.forEach(m => { m.storedSeq += 10; });
    const recent = await client.getInbox();
    expect(recent.checkpoint.channels.general.historyStartsAt).toBe(11);
    expect(recent.items.map(x => x.reasons)).toEqual([['reply'], ['mention']]);
    await expect(client.getInbox({ fromBeginning: true })).rejects.toThrow('gap');
  });

  it('progresses across more quiet channels than fit in one bounded scan', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/channels')
      ? Response.json({ channels: ['a', 'b', 'c'].map(name => ({ name, isPrivate: false })) })
      : Response.json({ messages: [] }));
    const client = await SwarmClient.init({ hubUrl: 'https://relay.test', autoRegister: false, fetch: fetcher });
    const one = await client.getInbox({ maxPages: 1 });
    const two = await client.getInbox({ maxPages: 1, checkpoint: one.checkpoint });
    const three = await client.getInbox({ maxPages: 1, checkpoint: two.checkpoint });
    expect([one.hasMore, two.hasMore, three.hasMore]).toEqual([true, true, false]);
    expect(Object.keys(three.checkpoint.channels)).toEqual(['a', 'b', 'c']);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/messages')).map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v1/channels/a/messages', '/v1/channels/b/messages', '/v1/channels/c/messages',
    ]);
  });

  describe('replies to posts older than the first recent window (#358)', () => {
    async function history(lookupReply: (url: URL, data: { me: any; own: any; early: any; late: any; peer: any }) => Response | undefined = () => undefined) {
      const me = await generateAgentKeyPair();
      const peer = await generateAgentKeyPair();
      const messages: Array<MessageEnvelope & { storedSeq: number }> = [];
      const append = async (who: typeof me, payload: Record<string, unknown>) => {
        const env = await signEnvelope({ channel: 'general', sender: who.agentId, type: 'intel', sequence: messages.length, payload }, who.signingPrivateKey);
        messages.push({ ...env, storedSeq: messages.length + 1 });
        return messages.at(-1)!;
      };
      const own = await append(me, { message: 'an old question' });
      const early = await append(peer, { message: 'an answer while I was away', inReplyTo: own.id });
      for (let n = 0; n < 57; n++) await append(peer, { message: `filler ${n}` });
      const late = await append(peer, { message: 'a later answer', inReplyTo: own.id });
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/channels') return Response.json({ channels: [{ name: 'general', isPrivate: false }] });
        if (url.pathname.endsWith('/replies')) return lookupReply(url, { me, own, early, late, peer })
          ?? Response.json({ agentId: me.agentId, threads: [{ post: own, replies: [early, late], moreReplies: false }], scannedPosts: 1 });
        if (url.pathname.startsWith('/v1/agents/')) return Response.json({ agent: { publicKey: url.pathname.endsWith(me.agentId) ? me.signingPublicKey : peer.signingPublicKey } });
        const after = url.searchParams.get('after');
        const limit = Number(url.searchParams.get('limit'));
        return Response.json({ messages: after === null ? messages.slice(-limit) : messages.filter(m => m.storedSeq > Number(after)).slice(0, limit) });
      });
      const client = await SwarmClient.init({ hubUrl: 'https://relay.test', keyPair: me, autoRegister: false, fetch: fetcher });
      return { client, fetcher, own, early, late, me, peer, messages };
    }
    const lookups = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([url]) => String(url).includes('/replies')).length;

    it('reports verified older replies once and recognizes later window replies to the same post', async () => {
      const { client, fetcher, own, early, late } = await history();
      const page = await client.getInbox();
      expect(page.checkpoint.channels.general.historyStartsAt).toBe(11);
      expect(page.items.map(item => item.envelope.id)).toEqual([early.id, late.id]);
      expect(page.items.every(item => item.reasons[0] === 'reply')).toBe(true);
      expect(page.checkpoint.channels.general.authoredIds).toContain(own.id);
      expect(page.replyLookup).toEqual({ status: 'used', olderReplies: 1, rejected: 0, truncated: false });
      const again = await client.getInbox({ checkpoint: page.checkpoint });
      expect(again.items).toEqual([]);
      expect(again.replyLookup).toBeUndefined();
      expect(lookups(fetcher)).toBe(1);
    });

    it('rejects forged, misattributed and mismatched lookup records without failing the window', async () => {
      const { client, late } = await history((_url, { me, own, early, peer }) => Response.json({ agentId: me.agentId, threads: [
        { post: own, replies: [{ ...early, payload: { ...early.payload, message: 'forged' } }, { ...early, payload: { message: 'x', inReplyTo: 'other' } }], moreReplies: true },
        { post: { ...own, sender: peer.agentId }, replies: [early] },
      ] }));
      const page = await client.getInbox();
      expect(page.items.map(item => item.envelope.id)).toEqual([late.id]);
      expect(page.replyLookup).toEqual({ status: 'used', olderReplies: 0, rejected: 3, truncated: true });
    });

    it('reports a reply once even when the hub misreports its unsigned storedSeq', async () => {
      const { client, late } = await history((_url, { me, own }) => Response.json({ agentId: me.agentId,
        threads: [{ post: own, replies: [{ ...late, storedSeq: 2 }], moreReplies: false }] }));
      const page = await client.getInbox();
      expect(page.items.map(item => item.envelope.id)).toEqual([late.id]);
      expect(page.replyLookup?.olderReplies).toBe(1);
    });

    it('falls back to the recent window when the hub does not serve the lookup', async () => {
      const { client } = await history(() => new Response('not found', { status: 404 }));
      const page = await client.getInbox();
      // The pre-#358 behavior: the older post is outside the window, so even the
      // in-window reply to it cannot be recognized.
      expect(page.items.map(item => item.envelope.id)).toEqual([]);
      expect(page.replyLookup).toEqual({ status: 'unavailable', olderReplies: 0, rejected: 0, truncated: false });
      expect(page.checkpoint.channels.general.authoredIds).toEqual([]);
    });

    it('never consults the lookup when the first window already starts at the beginning', async () => {
      const { client, fetcher } = await fixture();
      await client.getInbox();
      expect(fetcher.mock.calls.some(([url]) => String(url).includes('/replies'))).toBe(false);
    });
  });
});
