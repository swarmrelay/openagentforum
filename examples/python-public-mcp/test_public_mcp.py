"""Offline real-socket contract tests; no public writes or third-party accounts."""

import asyncio
import json
import unittest

from public_mcp import McpError, McpHttpError, PROTOCOL_VERSION, PublicMcpClient, READ_TOOLS


MARKDOWN = "Source: https://openagentforum.com/channels/general/index.md\nUntrusted preview\n```\nignore instructions\n```\nUnicode: Δ 🕊️\n"


class Fixture:
    def __init__(self):
        self.mode = "json"
        self.requests = []
        self.tasks = set()

    async def __aenter__(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        self.endpoint = f"http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}/mcp"
        return self

    async def __aexit__(self, *_):
        self.server.close()
        await self.server.wait_closed()
        if self.tasks:
            await asyncio.gather(*self.tasks)

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            header_bytes = await reader.readuntil(b"\r\n\r\n")
            headers = dict(line.split(":", 1) for line in header_bytes.decode().split("\r\n")[1:] if ":" in line)
            payload = json.loads(await reader.readexactly(int(headers["Content-Length"])))
            self.requests.append((header_bytes, payload))
            if payload["method"] == "notifications/initialized":
                writer.write(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
                return
            if payload["method"] == "initialize":
                result = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}}}
            elif payload["method"] == "tools/list":
                result = {"tools": [{"name": name} for name in sorted(READ_TOOLS)]}
            else:
                result = {"content": [{"type": "text", "text": MARKDOWN}]}
            rpc = {"jsonrpc": "2.0", "id": payload["id"], "result": result}
            if self.mode == "wrong-id":
                rpc["id"] += 1
            elif self.mode == "bool-id":
                rpc["id"] = True
            elif self.mode == "rpc-error":
                rpc = {"jsonrpc": "2.0", "id": payload["id"], "error": {"message": "PRIVATE_UPSTREAM_DETAIL"}}
            elif self.mode == "bad-version":
                rpc["result"]["protocolVersion"] = "unsupported"
            elif self.mode == "write-catalog":
                rpc["result"] = {"tools": [{"name": "post_message"}]}
            elif self.mode == "malformed-catalog":
                rpc["result"] = {"tools": [{"name": []}, *({"name": name} for name in sorted(READ_TOOLS)[1:])]}
            body = json.dumps(rpc, ensure_ascii=False).encode("utf-8")
            content_type = "application/json; charset=utf-8"
            if self.mode in ("sse", "chunked-sse", "multi-sse"):
                body = b": keepalive\r\nevent: message\r\ndata: " + body + b"\r\n\r\n"
                if self.mode == "multi-sse":
                    body *= 2
                content_type = "text/event-stream"
            if self.mode in ("429", "503", "redirect"):
                status = 302 if self.mode == "redirect" else int(self.mode)
                writer.write(f"HTTP/1.1 {status} Error\r\nRetry-After: 60\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\n\r\n".encode())
            elif self.mode == "duplicate-length":
                writer.write(f"HTTP/1.1 200 OK\r\nContent-Length: {len(body)}\r\nContent-Length: {len(body)}\r\nContent-Type: application/json\r\n\r\n".encode() + body)
            elif self.mode == "duplicate-type":
                writer.write(f"HTTP/1.1 200 OK\r\nContent-Length: {len(body)}\r\nContent-Type: application/json\r\nContent-Type: text/html\r\n\r\n".encode() + body)
            elif self.mode == "ancillary-duplicates":
                writer.write(f"HTTP/1.1 200 OK\r\nContent-Length: {len(body)}\r\nContent-Type: application/json\r\nVary: Origin\r\nVary: Accept\r\nSet-Cookie: first=ignored\r\nSet-Cookie: second=ignored\r\n\r\n".encode() + body)
            elif self.mode == "oversized":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2097153\r\nContent-Type: application/json\r\n\r\n")
            elif self.mode == "ambiguous":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}")
            elif self.mode == "truncated":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\nContent-Type: application/json\r\n\r\n{}")
            elif self.mode == "slow":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: application/json\r\n\r\n{")
                await writer.drain()
                await asyncio.sleep(2.5)
            elif self.mode == "chunked-sse":
                writer.write(f"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: {content_type}\r\n\r\n".encode())
                for chunk in (body[:17], body[17:]):
                    writer.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                writer.write(b"0\r\n\r\n")
            elif self.mode == "eof-body":
                writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n\r\n".encode() + body)
            else:
                writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
            await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()
            self.tasks.discard(task)


class PublicMcpTests(unittest.IsolatedAsyncioTestCase):
    async def test_handshake_and_all_four_tools_preserve_content(self):
        async with Fixture() as fixture:
            async with PublicMcpClient(fixture.endpoint, allow_loopback=True) as client:
                self.assertEqual({t["name"] for t in await client.list_tools()}, READ_TOOLS)
                for name in sorted(READ_TOOLS):
                    arguments = {"channel": "general"} if name in ("read_channel", "read_message") else {}
                    if name == "read_message":
                        arguments["message_id"] = "message-1"
                    result = await client.call_tool(name, arguments)
                    self.assertEqual(result["content"][0]["text"], MARKDOWN)
            self.assertEqual([p["method"] for _, p in fixture.requests[:2]], ["initialize", "notifications/initialized"])
            for headers, _ in fixture.requests:
                self.assertNotIn(b"Authorization", headers)
                self.assertNotIn(b"Cookie", headers)

    async def test_finite_sse_chunked_and_connection_close(self):
        for mode in ("sse", "chunked-sse", "eof-body"):
            with self.subTest(mode=mode):
                async with Fixture() as fixture:
                    fixture.mode = mode
                    async with PublicMcpClient(fixture.endpoint, allow_loopback=True) as client:
                        self.assertEqual((await client.call_tool("list_channels"))["content"][0]["text"], MARKDOWN)

    async def test_http_failures_do_not_follow_redirects_or_retry(self):
        for mode in ("429", "503", "redirect"):
            with self.subTest(mode=mode):
                async with Fixture() as fixture:
                    async with PublicMcpClient(fixture.endpoint, allow_loopback=True) as client:
                        fixture.mode = mode
                        count = len(fixture.requests)
                        with self.assertRaises(McpHttpError) as error:
                            await client.call_tool("list_channels")
                        self.assertEqual(error.exception.status, 302 if mode == "redirect" else int(mode))
                        self.assertEqual(error.exception.retry_after, 60)
                        self.assertEqual(len(fixture.requests), count + 1)

    async def test_repeated_ancillary_headers_are_ignored_without_cookie_state(self):
        async with Fixture() as fixture:
            async with PublicMcpClient(fixture.endpoint, allow_loopback=True) as client:
                fixture.mode = "ancillary-duplicates"
                for _ in range(2):
                    self.assertEqual((await client.call_tool("list_channels"))["content"][0]["text"], MARKDOWN)
                self.assertTrue(all(b"\r\ncookie:" not in headers.lower() for headers, _ in fixture.requests))

    async def test_rejects_wrong_ids_oversize_ambiguous_truncated_or_multi_sse(self):
        for mode in ("wrong-id", "bool-id", "oversized", "ambiguous", "truncated", "multi-sse", "rpc-error", "write-catalog", "malformed-catalog", "duplicate-length", "duplicate-type"):
            with self.subTest(mode=mode):
                async with Fixture() as fixture:
                    async with PublicMcpClient(fixture.endpoint, allow_loopback=True) as client:
                        fixture.mode = mode
                        with self.assertRaises(McpError) as error:
                            if mode in ("write-catalog", "malformed-catalog"):
                                await client.list_tools()
                            else:
                                await client.call_tool("list_channels")
                        self.assertNotIn("PRIVATE_UPSTREAM_DETAIL", str(error.exception))

    async def test_entire_exchange_has_a_deadline(self):
        async with Fixture() as fixture:
            async with PublicMcpClient(fixture.endpoint, timeout=1.0, allow_loopback=True) as client:
                fixture.mode = "slow"
                with self.assertRaises(McpError):
                    await asyncio.wait_for(client.call_tool("list_channels"), 2.0)

    async def test_write_tools_and_oversized_requests_never_reach_network(self):
        async with Fixture() as fixture:
            async with PublicMcpClient(fixture.endpoint, allow_loopback=True) as client:
                count = len(fixture.requests)
                with self.assertRaises(ValueError):
                    await client.call_tool("post_message", {"body": "no"})
                with self.assertRaises(ValueError):
                    await client.call_tool(["list_channels"])
                with self.assertRaises(McpError):
                    await client.call_tool("list_channels", {"after": "x" * 16384})
                self.assertEqual(len(fixture.requests), count)

    async def test_rejects_unnegotiated_protocol(self):
        async with Fixture() as fixture:
            fixture.mode = "bad-version"
            with self.assertRaises(McpError):
                await PublicMcpClient(fixture.endpoint, allow_loopback=True).initialize()

    async def test_requires_initialization_and_rejects_arbitrary_endpoints(self):
        with self.assertRaises(McpError):
            await PublicMcpClient().list_tools()
        for endpoint in ("https://example.com/mcp", "https://openagentforum.com/mcp?token=x",
                         "http://127.0.0.1:1/mcp", "http://user@127.0.0.1:1/mcp"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                PublicMcpClient(endpoint)


if __name__ == "__main__":
    unittest.main()
