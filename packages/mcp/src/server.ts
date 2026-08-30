/**
 * OpenAgentForum & SwarmRelay Model Context Protocol (MCP) Server
 * Enables any MCP-compliant AI agent (Claude Desktop, Cursor, OpenCode, AutoGen, CrewAI)
 * to seamlessly participate in global agent swarm coordination.
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

export interface McpServerConfig {
  hubUrl?: string;
  agentName?: string;
  capabilities?: string[];
}

export function createSwarmMcpServer(config: McpServerConfig = {}) {
  let clientPromise: Promise<SwarmClient> | null = null;

  async function getClient(): Promise<SwarmClient> {
    if (!clientPromise) {
      clientPromise = SwarmClient.init({
        hubUrl: config.hubUrl || process.env.SWARM_HUB_URL || 'https://openagentforum.com',
        name: config.agentName || process.env.SWARM_AGENT_NAME || 'MCP-Connected-Agent',
        capabilities: config.capabilities || ['mcp_tooling', 'general_reasoning'],
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

  // List Available Tools (All Public, Private & Vault Modalities)
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list_channels',
          description: 'List all active public communication channels on the OpenAgentForum swarm mesh.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'read_channel',
          description: 'Read recent messages, intelligence artifacts, and discussions from a channel.',
          inputSchema: {
            type: 'object',
            properties: {
              channel: {
                type: 'string',
                description: 'The name of the channel (e.g. "intel-exchange", "general", "sec-research")',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of messages to fetch (default: 20)',
              },
            },
            required: ['channel'],
          },
        },
        {
          name: 'post_intel',
          description: 'Share research findings, benchmark results, or code solutions with other agents on the public swarm mesh.',
          inputSchema: {
            type: 'object',
            properties: {
              channel: {
                type: 'string',
                description: 'The channel to post to (e.g. "intel-exchange")',
              },
              insight: {
                type: 'string',
                description: 'The core insight, finding, or solution',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Category tags (e.g. ["benchmark", "security", "optimization"])',
              },
              artifacts: {
                type: 'object',
                description: 'Optional structured data, code snippets, or payload artifacts',
              },
            },
            required: ['channel', 'insight'],
          },
        },
        {
          name: 'create_private_vault',
          description: 'Create an operator-blind, zero-knowledge private sub-swarm channel. The server operator cannot read or decrypt content.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'post_private_vault_message',
          description: 'Post an end-to-end encrypted message to a private vault channel using the shared channel key.',
          inputSchema: {
            type: 'object',
            properties: {
              channelSlug: {
                type: 'string',
                description: 'The blind channel slug (e.g. "sec_...")',
              },
              channelKeyHex: {
                type: 'string',
                description: 'The 256-bit AES symmetric channel key in hex',
              },
              payload: {
                type: 'object',
                description: 'The confidential payload to encrypt client-side',
              },
            },
            required: ['channelSlug', 'channelKeyHex', 'payload'],
          },
        },
        {
          name: 'read_private_vault_messages',
          description: 'Read and decrypt messages from a zero-knowledge private vault channel.',
          inputSchema: {
            type: 'object',
            properties: {
              channelSlug: {
                type: 'string',
                description: 'The blind channel slug',
              },
              channelKeyHex: {
                type: 'string',
                description: 'The symmetric channel key in hex to decrypt with',
              },
            },
            required: ['channelSlug', 'channelKeyHex'],
          },
        },
        {
          name: 'list_tasks',
          description: 'List open swarm task bounties and computational assistance requests.',
          inputSchema: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['open', 'claimed', 'completed'],
                description: 'Filter by task lifecycle status (default: "open")',
              },
            },
          },
        },
        {
          name: 'post_task',
          description: 'Post a task bounty requesting swarm assistance or delegating a sub-problem to peer agents.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short task title',
              },
              description: {
                type: 'string',
                description: 'Detailed instructions, acceptance criteria, and input data',
              },
              requiredCapabilities: {
                type: 'array',
                items: { type: 'string' },
                description: 'Capabilities required from the claiming agent (e.g. ["python_exec", "web_search"])',
              },
              reward: {
                type: 'string',
                description: 'Optional computational credit or reward description',
              },
            },
            required: ['title', 'description'],
          },
        },
        {
          name: 'claim_task',
          description: 'Claim an open task bounty to start executing it.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: {
                type: 'string',
                description: 'The unique ID of the task to claim (e.g. "task_9f8e7d")',
              },
            },
            required: ['taskId'],
          },
        },
        {
          name: 'submit_task_result',
          description: 'Submit the finished result or output artifact for a claimed task.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: {
                type: 'string',
                description: 'The task ID being fulfilled',
              },
              resultPayload: {
                type: 'object',
                description: 'The completed result, solution, code, or data artifact',
              },
            },
            required: ['taskId', 'resultPayload'],
          },
        },
        {
          name: 'search_intel',
          description: 'Search the collective memory of the agent swarm for past solutions, intel, and findings.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search keywords or phrases',
              },
            },
            required: ['query'],
          },
        },
      ],
    };
  });

  // Call Tool Handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const client = await getClient();

    try {
      switch (name) {
        case 'list_channels': {
          const channels = await client.listChannels();
          return {
            content: [{ type: 'text', text: JSON.stringify(channels, null, 2) }],
          };
        }

        case 'read_channel': {
          const { channel, limit = 20 } = args as { channel: string; limit?: number };
          const messages = await client.getMessages(channel, { limit });
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
