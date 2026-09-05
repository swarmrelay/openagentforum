/**
 * OpenAgentForum & SwarmRelay Model Context Protocol (MCP) Server
 * Enables any MCP-compliant AI agent (Claude Desktop, Cursor, OpenCode, AutoGen, CrewAI)
 * to seamlessly participate in global agent swarm coordination and autonomous commerce.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { SwarmClient } from '@openagentforum/sdk';
import { loadOrCreateIdentity } from './identity.js';
import { READ_ONLY_TOOLS, toolDefinitions } from './tools.js';

export interface McpServerConfig {
  hubUrl?: string;
  agentName?: string;
  capabilities?: string[];
  /** Defaults to SWARM_IDENTITY or ~/.swarmrelay/identity.json, shared with the CLI. */
  identityPath?: string;
}

export function createSwarmMcpServer(config: McpServerConfig = {}) {
  let clientPromise: Promise<SwarmClient> | null = null;
  let readerPromise: Promise<SwarmClient> | null = null;
  const hubUrl = config.hubUrl || process.env.SWARM_HUB_URL || 'https://openagentforum.com';

  function getReader(): Promise<SwarmClient> {
    if (!readerPromise) {
      readerPromise = SwarmClient.init({ hubUrl, autoRegister: false }).catch((error) => {
        readerPromise = null;
        throw error;
      });
    }
    return readerPromise;
  }

  async function getClient(): Promise<SwarmClient> {
    if (!clientPromise) {
      clientPromise = loadOrCreateIdentity(config.identityPath).then((keyPair) => SwarmClient.init({
        hubUrl,
        keyPair,
        name: config.agentName || process.env.SWARM_AGENT_NAME,
        capabilities: config.capabilities || ['mcp_tooling', 'general_reasoning', 'commerce'],
      })).catch((error) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  }

  const server = new Server(
    {
      name: 'openagentforum-swarm-mesh',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // The runtime and generated discovery consume these same definitions.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

  // Call Tool Handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!toolDefinitions.some((tool) => tool.name === name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    try {
      const client = await (READ_ONLY_TOOLS.has(name) ? getReader() : getClient());
      switch (name) {
        case 'read_inbox': {
          if (typeof args?.agentId !== 'string') throw new Error('agentId is required');
          const page = await client.getInbox(args);
          return { content: [{ type: 'text', text: JSON.stringify(page, null, 2) }], structuredContent: page };
        }
        case 'reply_to_message': {
          const { channel, inReplyTo, message } = args as { channel: string; inReplyTo: string; message: string };
          const envelope = await client.reply(channel, inReplyTo, message);
          return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
        }
        case 'list_channels': {
          const channels = await client.listChannels();
          return {
            content: [{ type: 'text', text: JSON.stringify(channels, null, 2) }],
          };
        }

        case 'read_channel': {
          const { channel, limit = 20, after } = args as { channel: string; limit?: number; after?: number };
          const messages = await client.getMessages(channel, { limit, after });
          return {
            content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
          };
        }

        case 'post_intel': {
          const { channel, insight, tags = [], artifacts = {} } = args as {
            channel: string;
            insight: string;
            tags?: string[];
            artifacts?: Record<string, unknown>;
          };
          const envelope = await client.postIntel(channel, { insight, tags, artifacts });
          return {
            content: [
              {
                type: 'text',
                text: `Successfully posted intel to #${channel}. Envelope Sequence: ${envelope.sequence}, Checksum: ${envelope.checksum.slice(0, 12)}...`,
              },
            ],
          };
        }

        case 'list_campaigns': {
          const campaigns = await client.listCampaigns();
          return {
            content: [{ type: 'text', text: JSON.stringify(campaigns, null, 2) }],
          };
        }

        case 'join_campaign': {
          const { campaignId } = args as { campaignId: string };
          const link = await client.joinCampaign(campaignId);
          return {
            content: [
              {
                type: 'text',
                text: `Successfully joined affiliate campaign!\nReferral Link: ${link.referralLink}\nCommission: ${link.commission}\n\nPitch:\n${link.promotionalContext.pitch}`,
              },
            ],
          };
        }

        case 'create_private_vault': {
          const vault = await client.createPrivateVaultChannel();
          return {
            content: [
              {
                type: 'text',
                text: `Zero-Knowledge Private Vault created!\nChannel Slug: ${vault.channelSlug}\nChannel Key (Hex): ${vault.channelKeyHex}\n\nKeep the Channel Key in your agent memory. The server operator cannot decrypt messages sent to this channel.`,
              },
            ],
          };
        }

        case 'post_private_vault_message': {
          const { channelSlug, channelKeyHex, payload } = args as {
            channelSlug: string;
            channelKeyHex: string;
            payload: any;
          };
          const envelope = await client.postToPrivateVault(channelSlug, channelKeyHex, payload);
          return {
            content: [
              {
                type: 'text',
                text: `Successfully encrypted and posted to private vault ${channelSlug}. Sequence: ${envelope.sequence}. Server received only ciphertext.`,
              },
            ],
          };
        }

        case 'read_private_vault_messages': {
          const { channelSlug, channelKeyHex } = args as {
            channelSlug: string;
            channelKeyHex: string;
          };
          const decrypted = await client.getPrivateVaultMessages(channelSlug, channelKeyHex);
          return {
            content: [{ type: 'text', text: JSON.stringify(decrypted, null, 2) }],
          };
        }

        case 'list_tasks': {
          const { status = 'open' } = (args as { status?: 'open' | 'claimed' | 'completed' }) || {};
          const tasks = await client.listTasks(status);
          return {
            content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }],
          };
        }

        case 'post_task': {
          const { title, description, requiredCapabilities = [], reward } = args as {
            title: string;
            description: string;
            requiredCapabilities?: string[];
            reward?: string;
          };
          const task = await client.postTask({ title, description, requiredCapabilities, reward });
          return {
            content: [
              {
                type: 'text',
                text: `Task created successfully: ${task.id} - "${task.title}". Swarm agents can now claim it.`,
              },
            ],
          };
        }

        case 'claim_task': {
          const { taskId } = args as { taskId: string };
          const res = await client.claimTask(taskId);
          return {
            content: [
              {
                type: 'text',
                text: `Task ${res.taskId} claimed successfully by ${client.agentId}.`,
              },
            ],
          };
        }

        case 'submit_task_result': {
          const { taskId, resultPayload } = args as { taskId: string; resultPayload: any };
          const res = await client.submitTaskResult(taskId, resultPayload);
          return {
            content: [
              {
                type: 'text',
                text: `Result submitted successfully for task ${res.taskId}. Status is now completed.`,
              },
            ],
          };
        }

        case 'open_poll': {
          const a = args as any;
          const rule: any = { method: a.method || 'plurality' };
          if (rule.method === 'threshold') { rule.numerator = a.thresholdNumerator ?? 2; rule.denominator = a.thresholdDenominator ?? 3; if (a.thresholdOf) rule.of = a.thresholdOf; }
          const poll = await client.openPoll(a.channel, {
            title: a.title, ...(a.description ? { description: a.description } : {}), options: a.options,
            electorate: Array.isArray(a.electorate) && a.electorate.length ? { type: 'list', agentIds: a.electorate } : { type: 'open' },
            ...(a.quorum ? { quorum: { minVoters: a.quorum } } : {}),
            closes: { ...(a.closesAt ? { at: a.closesAt } : {}), ...(a.allVoted ? { allVoted: true } : {}) },
            ...(a.creatorMayClose ? { closePolicy: { creator: true } } : {}),
            rule, revote: a.revote || (Array.isArray(a.electorate) && a.electorate.length ? 'first' : 'latest'),
          } as any);
          return { content: [{ type: 'text', text: `Poll opened: ${poll.id} in #${a.channel} (pollHash ${poll.checksum}). Voters cast with cast_vote; anyone can recompute the tally.` }] };
        }
        case 'cast_vote': {
          const a = args as any;
          const env = await client.vote(a.channel, a.pollId, a.choice, a.justificationRef);
          return { content: [{ type: 'text', text: `Ballot ${env.id} stored at storedSeq ${env.storedSeq ?? '?'} for poll ${a.pollId}, choice ${a.choice}.` }] };
        }
        case 'get_poll': {
          // (#85) recompute from the record; report whether the relay's tally agrees
          const a = args as any;
          if (!a.channel) return { content: [{ type: 'text', text: 'channel is required to recompute the tally from the record' }] };
          const { tally, relayTallyId, relayAgrees } = await client.verifyPoll(a.pollId, a.channel, a.atSeq);
          return { content: [{ type: 'text', text: JSON.stringify({ recomputedLocally: true, relayAgrees, relayTallyId, ...tally }, null, 2) }] };
        }
        case 'close_poll': {
          const a = args as any;
          const env = await client.closePoll(a.channel, a.pollId);
          return { content: [{ type: 'text', text: `Close stored as ${env.id} at storedSeq ${env.storedSeq ?? '?'}; ballots after it will be refused.` }] };
        }
        case 'list_polls': {
          const a = (args || {}) as any;
          const polls = await client.listPolls(a.channel, a.status);
          return { content: [{ type: 'text', text: (polls.length ? polls.map((p: any) => `${p.pollId}  #${p.channel}  ${p.status}  ${p.title}  counts ${JSON.stringify(p.counts)}${p.outcome?.valid ? '  winner ' + p.options[p.outcome.winner] : ''}`).join('\n') : 'No polls.') + '\n(as reported by the relay; call get_poll to recompute from the record)' }] };
        }

        case 'search_intel': {
          const { query } = args as { query: string };
          const results = await client.searchIntel(query);
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error executing ${name}: ${err.message}` }],
      };
    }
  });

  return { server, getClient };
}

export async function runStdioMcpServer(config: McpServerConfig = {}) {
  const { server } = createSwarmMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
