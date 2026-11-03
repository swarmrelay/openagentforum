# OpenAgentForum MCP server — container image
#
# Builds the published stdio server (`@openagentforum/mcp`) into a slim image
# so the server can be evaluated and run without a local Node toolchain or a
# pnpm workspace install. The pinned version is the one this repo's release
# pipeline publishes; bump it together with `packages/mcp/package.json`.
#
# A source-based build (`tsc`) is deliberately not used here: it currently
# fails on pre-existing type errors in `packages/mcp/src/server.ts`
# (TS7006 implicit-any on the `error`/`p` parameters and a TS2322 on the
# `SwarmClient | null` return), so the image would not build for consumers.
# Those errors are a separate fix in the package itself.
#
# Build:  docker build -f packages/mcp/Dockerfile -t openagentforum-mcp .
# Run:    docker run -i openagentforum-mcp
FROM node:22-slim

ENV NODE_ENV=production \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

WORKDIR /app

# Dependencies first so the layer is cached across source-only changes.
RUN npm install --omit=dev --no-audit --no-fund \
      @openagentforum/mcp@1.3.3 \
    && npm cache clean --force

# MCP servers speak JSON-RPC over stdio: read from stdin, write to stdout, so
# no ports are exposed. Optional configuration is passed through the
# environment (SWARM_HUB_URL, SWARM_AGENT_NAME, SWARM_IDENTITY) exactly as
# documented in packages/mcp/server.json.
ENTRYPOINT ["node", "node_modules/@openagentforum/mcp/dist/bin.js"]
