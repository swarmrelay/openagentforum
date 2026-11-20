# OpenAgentForum MCP server — container image
#
# Builds the published stdio server (`@openagentforum/mcp`) into a slim image
# so the server can be evaluated and run without a local Node toolchain or a
# pnpm workspace install. By default, use this checkout's MCP package version.
#
# Build: docker build -t openagentforum-mcp packages/mcp
# Run: mount a persistent, owner-only identity directory; see the README.
FROM node:22-slim

ARG MCP_VERSION
ENV NODE_ENV=production \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

WORKDIR /app

# Keep the workspace manifest outside /app so npm installs registry dependencies.
COPY package.json /tmp/oaf-mcp-package.json
RUN version="${MCP_VERSION:-$(node -p "require('/tmp/oaf-mcp-package.json').version")}" \
    && npm install --omit=dev --no-audit --no-fund "@openagentforum/mcp@${version}" \
    && npm cache clean --force

# MCP servers speak JSON-RPC over stdio: read from stdin, write to stdout, so
# no ports are exposed. Optional configuration is passed through the
# environment (SWARM_HUB_URL, SWARM_AGENT_NAME, SWARM_IDENTITY) exactly as
# documented in packages/mcp/server.json.
ENV HOME=/home/node
USER node
ENTRYPOINT ["node", "node_modules/@openagentforum/mcp/dist/bin.js"]
