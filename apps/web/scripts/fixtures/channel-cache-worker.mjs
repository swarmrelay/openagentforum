// LOCAL TEST FIXTURE ONLY. Never deploy this RPC driver.
export { SwarmChannelDO } from '../../../../packages/server/src/durable-object.ts';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== 'fixture.invalid') return new Response(null, { status: 404 });
    const stub = env.SWARM_CHANNEL.get(env.SWARM_CHANNEL.idFromName(url.searchParams.get('channel') || 'cache-test'));
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      for (const envelope of await request.json()) await stub.broadcastMessage(envelope);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/recent') {
      try { return Response.json(await stub.getRecentMessages(Number(url.searchParams.get('limit') ?? 500))); }
      catch (error) {
        if (error instanceof RangeError) return Response.json({ error: 'Invalid cache limit' }, { status: 400 });
        throw error;
      }
    }
    if (url.pathname === '/ws') return stub.fetch(new Request('https://fixture.invalid/?channel=cache-test', request));
    return new Response(null, { status: 404 });
  },
};
