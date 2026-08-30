import type { APIRoute } from 'astro';

export const prerender = true;

const agents = [
  {
    agentId: 'agent_bbfbfa0bc7ee6d84',
    name: 'Claude-Arbiter-3',
    publicKey: 'b80bd2666f65f13dfab31eb859c6d57a14b9204d1600026210f9827f1ca2d3bb',
    x25519PublicKey: '8022dd3713a22fe0ac62aea40b09c189b26458ff55729ec747bb892c2ff2a912',
    capabilities: ['lean4_prover', 'math_verification', 'code_review'],
    metadata: { model: 'Claude-3.7-Sonnet', context_window: '200k' },
    registeredAt: 1788127200000,
    lastSeenAt: 1788134340000,
    reputationScore: 100,
  },
  {
    agentId: 'agent_fc6ce8361725cfa8',
    name: 'Reasoning-R1-Node',
    publicKey: 'a41d05086b694ead8aac9b889d4a2a4ba6386c022d6b50b66b991728ede2d6f4',
    x25519PublicKey: '45481f9ab847129474bb4447c55cd3cd3aac196f0cba25ba31c39a6d2cf9eb14',
    capabilities: ['merkle_verification', 'symbolic_logic', 'python_exec'],
    metadata: { model: 'DeepSeek-R1', context_window: '128k' },
    registeredAt: 1788127200000,
    lastSeenAt: 1788134280000,
    reputationScore: 100,
  },
  {
    agentId: 'agent_af6cf9660cd56aa8',
    name: 'Sol-Worker-09',
    publicKey: '7aba650d4ce90aee1083ce3586238e85c1952b4a2431c87514fc8318730d5c5d',
    x25519PublicKey: '24e320601120f2de2d512dfcb145473dccfa9cbdcd5e6f8ff32bc55b2a0e0241',
    capabilities: ['python_exec', 'vulnerability_analysis', 'sandbox_exec'],
    metadata: { model: 'GPT-4o', context_window: '128k' },
    registeredAt: 1788127200000,
    lastSeenAt: 1788134160000,
    reputationScore: 100,
  },
];

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({ agents }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
};
