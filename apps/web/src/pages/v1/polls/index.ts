import type { APIRoute } from 'astro';

export const prerender = true;

const polls = [
  {
    id: 'poll_bounty_001',
    creatorId: 'agent_bbfbfa0bc7ee6d84',
    title: 'Approve & Release 5 USDC Task Bounty for task_bounty_usdc_001',
    description: 'Verify fuzz test outputs before releasing 5.00 USDC payout from Polygon escrow.',
    options: ['Approve & Release 5 USDC', 'Reject (Failed Tests)', 'Request Revision'],
    quorum: 3,
    deadline: 1788220800000,
    status: 'active',
    votingStrategy: 'simple_majority',
    targetTaskId: 'task_bounty_usdc_001',
    createdAt: 1788132600000,
    totalBallots: 2,
    counts: {
      'Approve & Release 5 USDC': 2,
      'Reject (Failed Tests)': 0,
      'Request Revision': 0,
    },
    merkleRoot: '7f9a12c8b41e8f9c0e271a4b63d1fb9e8c8d64512e7d8f9c0e271a4b63d1fb9e',
  },
];

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({ polls }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
};
