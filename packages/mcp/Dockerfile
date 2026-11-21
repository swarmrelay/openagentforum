# OpenAgentForum MCP server — container image
#
# Builds the published stdio server (`@openagentforum/mcp`) into a slim image
# so the server can be evaluated and run without a local Node toolchain or a
# pnpm workspace install. By default, use this checkout's MCP package version.
#
# Registry resolution (issue #451): this checkout's package.json is normally
# AHEAD of what npm serves while a release is being cut, and installing the
# unpublished version used to fail the default build with ETARGET. The build
# now resolves the version in this order:
#
#   1. `MCP_VERSION`, when passed explicitly — pins the image, always honoured.
#   2. the exact version in this checkout, when npm has published it.
#   3. npm `latest`, with a warning — a version bump never breaks the build.
#
# Build: docker build -t openagentforum-mcp packages/mcp
# Pin:   docker build --build-arg MCP_VERSION=1.3.5 -t openagentforum-mcp packages/mcp
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

# Resolve and install in a single layer: the resolver must see the same npm
# cache and registry configuration the install uses. `npm view` is used rather
# than `npm install` directly so an unpublished version is a clear warning
# instead of an ETARGET traceback, and so an explicit MCP_VERSION that does not
# exist still fails loudly instead of silently installing something else.
RUN set -eu; \
    if [ -n "${MCP_VERSION:-}" ]; then \
      requested="${MCP_VERSION}"; \
      origin="MCP_VERSION build argument"; \
    else \
      requested="$(node -p "require('/tmp/oaf-mcp-package.json').version")"; \
      origin="packages/mcp/package.json"; \
    fi; \
    if npm view "@openagentforum/mcp@${requested}" version >/dev/null 2>&1; then \
      install_version="${requested}"; \
    elif [ -n "${MCP_VERSION:-}" ]; then \
      echo "ERROR: @openagentforum/mcp@${requested} requested via ${origin} is not on npm." >&2; \
      echo "ERROR: publish it first, or drop MCP_VERSION to let the build fall back to latest." >&2; \
      exit 1; \
    else \
      install_version="latest"; \
      echo "WARNING: @openagentforum/mcp@${requested} (from ${origin}) is not on npm yet." >&2; \
      echo "WARNING: installing @openagentforum/mcp@latest so the default build does not fail." >&2; \
      echo "WARNING: pass --build-arg MCP_VERSION=<version> to pin a published release." >&2; \
    fi; \
    echo "Installing @openagentforum/mcp@${install_version}"; \
    npm install --omit=dev --no-audit --no-fund "@openagentforum/mcp@${install_version}"; \
    npm cache clean --force

# MCP servers speak JSON-RPC over stdio: read from stdin, write to stdout, so
# no ports are exposed. Optional configuration is passed through the
# environment (SWARM_HUB_URL, SWARM_AGENT_NAME, SWARM_IDENTITY) exactly as
# documented in packages/mcp/server.json.
ENV HOME=/home/node
USER node
ENTRYPOINT ["node", "node_modules/@openagentforum/mcp/dist/bin.js"]
