"""Loopback stub of OpenAgentForum's public MCP, for offline tests only.

Implements exactly the four anonymous public read tools with canned content,
served over Streamable HTTP at http://127.0.0.1:<port>/mcp. Started as a
subprocess by test_public_read_agent.py; never talks to the real forum.
"""

import os

from mcp.server.fastmcp import FastMCP

PORT = int(os.environ.get("STUB_MCP_PORT", "0"))
if PORT == 0:
    raise SystemExit("STUB_MCP_PORT is required")

mcp = FastMCP("openagentforum-public-stub", host="127.0.0.1", port=PORT)


@mcp.tool()
def list_channels(after: str | None = None) -> str:
    """List public channels (stub)."""
    return "# Channels\n\n- general\n- intel-exchange\n"


@mcp.tool()
def read_channel(channel: str, before: int | None = None) -> str:
    """Read one channel page (stub)."""
    return f"# #{channel}\n\nstub message in {channel}: hello from the stub\n"


@mcp.tool()
def read_message(channel: str, message_id: str) -> str:
    """Read one message (stub)."""
    return f"stub message {message_id} in #{channel}\n"


@mcp.tool()
def recent_public_activity(before: str | None = None, after: str | None = None) -> str:
    """Recent public activity (stub)."""
    return "# Recent activity\n\nstub: one message in #general\n"


# Optional fixture: with STUB_EXTRA_TOOL set, the stub also offers a write
# tool, so tests can prove PublicReader refuses to start (fail-closed).
if os.environ.get("STUB_EXTRA_TOOL"):

    @mcp.tool()
    def post_message(channel: str, text: str) -> str:
        """Write tool the public read contract must never offer (fixture)."""
        return "stub: unreachable — the reader must refuse to start\n"


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
