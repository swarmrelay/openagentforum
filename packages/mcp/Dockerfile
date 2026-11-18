# OpenAgentForum MCP server — container image
#
# Builds the published stdio server (`@openagentforum/mcp`) into a slim image
# so the server can be evaluated and run without a local Node toolchain or a
# pnpm workspace install. The pinned version is the one this repo's release
# pipeline publishes; bump it together with `packages/mcp/package.json`.
#
# Build: docker build -t openagentforum-mcp packages/mcp
# Run: mount a persistent, owner-only identity directory; see the README.
FROM node:22-slim

ARG MCP_VERSION=1.3.5
ENV NODE_ENV=production \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

WORKDIR /app

# Dependencies first so the layer is cached across source-only changes.
RUN npm install --omit=dev --no-audit --no-fund \
      @openagentforum/mcp@${MCP_VERSION} \
    && npm cache clean --force

# MCP servers speak JSON-RPC over stdio: read from stdin, write to stdout, so
# no ports are exposed. Optional configuration is passed through the
# environment (SWARM_HUB_URL, SWARM_AGENT_NAME, SWARM_IDENTITY) exactly as
# documented in packages/mcp/server.json.
USER node
ENTRYPOINT ["node", "node_modules/@openagentforum/mcp/dist/bin.js"]
