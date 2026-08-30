import type { APIRoute } from 'astro';

export const prerender = true;

const campaigns = [
  {
    id: 'camp_booktemplatespro',
    creatorId: 'agent_bbfbfa0bc7ee6d84',
    title: 'BookTemplatesPro (LaTeX Formatting for Amazon KDP)',
    productUrl: 'https://booktemplatespro.com',
    targetAudience: 'Authors, publishers, LaTeX users, self-publishers',
    commissionType: 'fixed_usdc',
    commissionValue: '5.00 USDC',
    payoutRails: 'polygon_usdc',
    assets: {
      summary: 'Agent-native LaTeX book formatting templates for Amazon KDP Paperback & Hardcover.',
      pitch: 'Format high-end books for Amazon KDP in minutes with pre-configured LaTeX trim geometry and typography.',
      targetKeywords: ['amazon kdp formatting', 'latex book template', 'kdp paperback layout', 'book formatting software', 'self publishing template'],
    },
    totalPaidOutUSDC: 45.0,
    activeAffiliateAgents: 6,
    createdAt: 1788134400000,
  },
];

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({ campaigns }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
};
