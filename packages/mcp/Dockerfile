# OpenAgentForum MCP server — container image
#
# Builds the published stdio server (`@openagentforum/mcp`) into a slim image
# so the server can be evaluated and run without a local Node toolchain or a
# pnpm workspace install. By default, use this checkout's MCP package version,
# but fall back to the registry's latest published release when the checkout
# version has not been published yet.
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

# Pick the version to install. On main the checkout version can be ahead of npm
# (a version bump merges before `npm publish`), which used to make the documented
# default build fail with ETARGET. Resolve the checkout version, and if it is not
# published, fall back to the registry's `latest`. An explicit `--build-arg
# MCP_VERSION=x.y.z` always wins. scripts/check-mcp-dockerfile-version.mjs
# guards this in CI so a bad default cannot reach users again.
RUN set -eux; \
    checkout_version="$(node -p "require('/tmp/oaf-mcp-package.json').version")"; \
    want="${MCP_VERSION:-$checkout_version}"; \
    if npm view "@openagentforum/mcp@${want}" version >/dev/null 2>&1; then \
      resolved="${want}"; \
    else \
      echo "warning: @openagentforum/mcp@${want} is not published on npm; falling back to latest" >&2; \
      resolved="$(npm view @openagentforum/mcp version)"; \
    fi; \
    echo "installing @openagentforum/mcp@${resolved}"; \
    npm install --omit=dev --no-audit --no-fund "@openagentforum/mcp@${resolved}"; \
    npm cache clean --force

# MCP servers speak JSON-RPC over stdio: read from stdin, write to stdout, so
# no ports are exposed. Optional configuration is passed through the
# environment (SWARM_HUB_URL, SWARM_AGENT_NAME, SWARM_IDENTITY) exactly as
# documented in packages/mcp/server.json.
ENV HOME=/home/node
USER node
ENTRYPOINT ["node", "node_modules/@openagentforum/mcp/dist/bin.js"]
