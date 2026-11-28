"""Offline tests for forum_tools, driven by in-memory stub clients.

No network: a synchronous fake session records the forwarded calls for
the adapter tests, and a real ``ForumSession`` is exercised against an
async stub client to pin the thread bridge (loop ownership, catalog
validation, refusal of unknown tools) without touching the live service.
"""

import asyncio
import unittest

from forum_tools import (
    READ_TOOL_NAMES,
    ForumSession,
    ListChannelsArgs,
    ReadChannelArgs,
    ReadMessageArgs,
    RecentPublicActivityArgs,
    build_forum_tools,
    flatten_tool_result,
)


def text_result(text, *, is_error=False):
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


class FakeSession:
    """Synchronous stand-in with the ForumSession.call_tool contract."""

    def __init__(self, result):
        self.result = result
        self.calls = []

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return self.result


class StubAsyncClient:
    """Async stand-in with the PublicMcpClient contract."""

    def __init__(self, result):
        self.result = result
        self.calls = []
        self.entered = False
        self.exited = False

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.exited = True
        return False

    async def list_tools(self):
        return list(READ_TOOL_NAMES)

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return self.result


class BuildForumToolsTests(unittest.TestCase):
    def setUp(self):
        self.session = FakeSession(text_result("ok"))
        self.tools = {tool.name: tool for tool in build_forum_tools(self.session)}

    def test_tool_set_matches_published_read_tools(self):
        self.assertEqual(set(self.tools), set(READ_TOOL_NAMES))

    def test_schemas_expose_the_published_arguments(self):
        self.assertEqual(set(self.tools["list_channels"].args_schema.model_fields), {"after"})
        self.assertEqual(set(self.tools["read_channel"].args_schema.model_fields), {"channel", "before"})
        self.assertEqual(
            set(self.tools["read_message"].args_schema.model_fields), {"channel", "message_id"}
        )
        self.assertEqual(
            set(self.tools["recent_public_activity"].args_schema.model_fields), {"before", "after"}
        )
        self.assertEqual(self.tools["read_message"].args_schema.model_fields["message_id"].annotation, str)

    def test_arguments_forward_without_none_optionals(self):
        output = self.tools["read_channel"]._run(channel="general")
        self.assertEqual(output, "ok")
        self.assertEqual(self.session.calls, [("read_channel", {"channel": "general"})])

    def test_arguments_forward_with_optionals(self):
        self.tools["list_channels"]._run(after="general")
        self.tools["read_channel"]._run(channel="general", before=42)
        self.tools["read_message"]._run(channel="general", message_id="m-1")
        self.tools["recent_public_activity"]._run(after="cursor-1")
        self.assertEqual(
            self.session.calls,
            [
                ("list_channels", {"after": "general"}),
                ("read_channel", {"channel": "general", "before": 42}),
                ("read_message", {"channel": "general", "message_id": "m-1"}),
                ("recent_public_activity", {"after": "cursor-1"}),
            ],
        )

    def test_unbound_tool_refuses_to_run(self):
        tool = type(self.tools["list_channels"])()
        with self.assertRaises(RuntimeError):
            tool._run()


class ArgsSchemaTests(unittest.TestCase):
    def test_required_arguments_are_enforced(self):
        with self.assertRaises(Exception):
            ReadChannelArgs()
        with self.assertRaises(Exception):
            ReadMessageArgs(channel="general")

    def test_invalid_bookmarks_are_rejected(self):
        with self.assertRaises(Exception):
            RecentPublicActivityArgs(before="one", after="two")

    def test_invalid_channel_positions_are_rejected(self):
        for before in (0, 9007199254740992, 1.5, True, "42"):
            with self.assertRaises(Exception, msg=f"before={before!r}"):
                ReadChannelArgs(channel="general", before=before)

    def test_boundary_channel_positions_are_accepted(self):
        self.assertEqual(ReadChannelArgs(channel="general", before=1).before, 1)
        self.assertEqual(
            ReadChannelArgs(channel="general", before=9007199254740991).before, 9007199254740991
        )

    def test_optional_arguments_default_to_none(self):
        self.assertIsNone(ListChannelsArgs().after)
        self.assertIsNone(ReadChannelArgs(channel="general").before)
        self.assertIsNone(RecentPublicActivityArgs().before)
        self.assertIsNone(RecentPublicActivityArgs().after)


class ForumSessionTests(unittest.TestCase):
    def test_session_forwards_calls_across_the_thread_bridge(self):
        client = StubAsyncClient(text_result("ok"))
        with ForumSession(lambda: client) as session:
            self.assertTrue(client.entered)
            self.assertEqual(session.list_tools(), list(READ_TOOL_NAMES))
            result = session.call_tool("read_channel", {"channel": "general"})
            self.assertEqual(result, text_result("ok"))
            tools = {tool.name: tool for tool in build_forum_tools(session)}
            self.assertEqual(tools["read_channel"]._run(channel="general"), "ok")
        self.assertTrue(client.exited)
        self.assertEqual(
            client.calls,
            [("read_channel", {"channel": "general"}), ("read_channel", {"channel": "general"})],
        )

    def test_session_refuses_unknown_tools_before_forwarding(self):
        client = StubAsyncClient(text_result("ok"))
        with ForumSession(lambda: client) as session:
            with self.assertRaises(ValueError):
                session.call_tool("post_message", {"channel": "general"})
        self.assertEqual(client.calls, [])

    def test_call_tool_before_start_raises(self):
        session = ForumSession(lambda: StubAsyncClient(text_result("ok")))
        with self.assertRaises(RuntimeError):
            session.call_tool("list_channels", {})


class FlattenToolResultTests(unittest.TestCase):
    def test_joins_text_blocks_in_order(self):
        result = {"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}
        self.assertEqual(flatten_tool_result(result), "a\nb")

    def test_non_text_blocks_become_placeholders(self):
        result = {"content": [{"type": "image", "data": "..."}, {"type": "text", "text": "x"}]}
        self.assertEqual(flatten_tool_result(result), "[image content omitted]\nx")

    def test_error_results_are_prefixed_not_raised(self):
        self.assertEqual(flatten_tool_result(text_result("boom", is_error=True)), "Error: boom")
        self.assertEqual(flatten_tool_result({"content": [], "isError": True}), "Error: tool call failed")

    def test_missing_content_is_empty(self):
        self.assertEqual(flatten_tool_result({}), "")
        self.assertEqual(flatten_tool_result("plain"), "plain")


if __name__ == "__main__":
    unittest.main()
