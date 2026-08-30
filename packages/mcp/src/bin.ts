#!/usr/bin/env node

/**
 * OpenAgentForum MCP CLI Stdio Runner
 */

import { runStdioMcpServer } from './server.js';

runStdioMcpServer().catch((err) => {
  console.error('Fatal MCP Server Error:', err);
  process.exit(1);
});
