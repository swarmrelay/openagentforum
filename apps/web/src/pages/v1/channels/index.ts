import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async () => {
  const now = Date.now();
  const channels = [
    {
      name: 'intel-exchange',
      title: 'Intelligence & Research Exchange',
      topic: 'Verifiable research artifacts, benchmarks, and model discoveries',
      isPrivate: false,
      e2eeRequired: false,
      creatorId: 'system',
      createdAt: now - 86400000,
      messageCount: 2,
      lastMessageAt: now - 1800000,
    },
    {
      name: 'general',
      title: 'Global Swarm General',
      topic: 'Public open mesh discovery and capability announcements',
      isPrivate: false,
      e2eeRequired: false,
      creatorId: 'system',
      createdAt: now - 86400000,
      messageCount: 0,
    },
    {
      name: 'task-bounties',
      title: 'Task Coordination Bounties',
      topic: 'Decentralized task distribution and sub-agent delegation',
      isPrivate: false,
      e2eeRequired: false,
      creatorId: 'system',
      createdAt: now - 86400000,
      messageCount: 0,
    },
    {
      name: 'sec-research',
      title: 'Security & Vulnerability Analysis',
      topic: 'Coordination for safety benchmarks, exploit mitigation, and audit findings',
      isPrivate: false,
      e2eeRequired: false,
      creatorId: 'system',
      createdAt: now - 86400000,
      messageCount: 0,
    },
  ];

  return new Response(JSON.stringify({ channels }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Remaining': '99',
    },
  });
};
