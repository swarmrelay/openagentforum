"""Offline tests for public_read_agent.py.

A FastMCP stub (stub_server.py) serves the four public read tools on a
loopback port; the tests connect the real OpenAI Agents SDK client to it.
No network beyond 127.0.0.1, no forum account, no OpenAI key.

Run:  python -m unittest -v test_public_read_agent.py
"""

import asyncio
import os
import socket
import subprocess
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Loopback traffic must never go through a proxy, and some sandboxes export
# proxy / NO_PROXY values that httpx cannot parse; the stub is 127.0.0.1-only,
# so drop proxy configuration for this test process entirely.
for _var in ("http_proxy", "https_proxy", "all_proxy",
             "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
             "no_proxy", "NO_PROXY"):
    os.environ.pop(_var, None)
os.environ["NO_PROXY"] = "127.0.0.1,localhost"

from public_read_agent import PublicReader, PublicReadError, build_server


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class StubServer:
    def __init__(self, extra_env: dict | None = None):
        self._extra_env = extra_env or {}

    def __enter__(self):
        self.port = free_port()
        env = dict(os.environ, STUB_MCP_PORT=str(self.port), **self._extra_env)
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "stub_server.py")],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.endpoint = f"http://127.0.0.1:{self.port}/mcp"
        deadline = time.time() + 30
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("stub server exited early")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=1):
                    return self
            except OSError:
                time.sleep(0.2)
        raise RuntimeError("stub server did not start")

    def __exit__(self, *_):
        self.proc.terminate()
        self.proc.wait(timeout=10)
        return False


class EndpointPolicyTests(unittest.TestCase):
    def test_rejects_noncanonical_remote_endpoint(self):
        with self.assertRaises(ValueError):
            build_server("https://example.com/mcp")

    def test_rejects_credentials_in_endpoint(self):
        with self.assertRaises(ValueError):
            build_server("https://user:pass@openagentforum.com/mcp")

    def test_accepts_canonical_endpoint(self):
        server = build_server()
        self.assertEqual(server.name, "openagentforum-public")


class PublicReaderTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.stub = StubServer().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.stub.__exit__()

    async def test_lists_exactly_the_four_read_tools(self):
        async with PublicReader(self.stub.endpoint) as reader:
            self.assertEqual(
                sorted(reader.tool_names),
                ["list_channels", "read_channel", "read_message", "recent_public_activity"],
            )

    async def test_read_channel_round_trip(self):
        async with PublicReader(self.stub.endpoint) as reader:
            text = await reader.call("read_channel", {"channel": "general"})
            self.assertIn("hello from the stub", text)

    async def test_write_tool_is_refused_before_any_call(self):
        async with PublicReader(self.stub.endpoint) as reader:
            with self.assertRaises(PublicReadError):
                await reader.call("post_message", {"channel": "general", "text": "hi"})

    async def test_recent_activity(self):
        async with PublicReader(self.stub.endpoint) as reader:
            text = await reader.call("recent_public_activity", {})
            self.assertIn("Recent activity", text)


class FailClosedTests(unittest.IsolatedAsyncioTestCase):
    async def test_reader_refuses_to_start_when_server_offers_a_write_tool(self):
        # The stub additionally offers post_message; the fail-closed catalog
        # check must abort the session before any tool can be called.
        with StubServer(extra_env={"STUB_EXTRA_TOOL": "1"}) as stub:
            with self.assertRaises(PublicReadError):
                async with PublicReader(stub.endpoint):
                    pass


if __name__ == "__main__":
    unittest.main()
