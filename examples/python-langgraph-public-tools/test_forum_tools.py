"""Offline tests for forum_tools, driven by an in-memory stub client.

No network: the stub records the forwarded calls and returns canned MCP
results, so these tests pin the adapter contract (tool set, argument
forwarding, content flattening) without touching the live service.
"""

import asyncio
import unittest

from forum_tools import READ_TOOL_NAMES, build_forum_tools, flatten_tool_result


class StubClient:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return self.result


def text_result(text, *, is_error=False):
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


class BuildForumToolsTests(unittest.TestCase):
    def setUp(self):
        self.client = StubClient(text_result("ok"))
        self.tools = {tool.name: tool for tool in build_forum_tools(self.client)}

    def test_tool_set_matches_published_read_tools(self):
        self.assertEqual(set(self.tools), set(READ_TOOL_NAMES))

    def test_schemas_expose_the_published_arguments(self):
        self.assertEqual(set(self.tools["list_channels"].args), {"after"})
        self.assertEqual(set(self.tools["read_channel"].args), {"channel", "before"})
        self.assertEqual(set(self.tools["read_message"].args), {"channel", "message_id"})
        self.assertEqual(set(self.tools["recent_public_activity"].args), {"before", "after"})
        self.assertIn("channel", self.tools["read_channel"].args_schema.model_fields)
        self.assertEqual(
            self.tools["read_message"].args_schema.model_fields["message_id"].annotation, str
        )

    def test_required_arguments_are_enforced(self):
        with self.assertRaises(Exception):
            asyncio.run(self.tools["read_channel"].ainvoke({}))

    def test_arguments_forward_without_none_optionals(self):
        asyncio.run(self.tools["read_channel"].ainvoke({"channel": "general"}))
        self.assertEqual(self.client.calls, [("read_channel", {"channel": "general"})])

    def test_arguments_forward_with_optionals(self):
        asyncio.run(self.tools["list_channels"].ainvoke({"after": "general"}))
        asyncio.run(self.tools["read_channel"].ainvoke({"channel": "general", "before": 42.0}))
        asyncio.run(
            self.tools["read_message"].ainvoke({"channel": "general", "message_id": "m-1"})
        )
        self.assertEqual(
            self.client.calls,
            [
                ("list_channels", {"after": "general"}),
                ("read_channel", {"channel": "general", "before": 42.0}),
                ("read_message", {"channel": "general", "message_id": "m-1"}),
            ],
        )

    def test_tool_output_is_the_flattened_text(self):
        output = asyncio.run(self.tools["recent_public_activity"].ainvoke({}))
        self.assertEqual(output, "ok")
        self.assertEqual(self.client.calls, [("recent_public_activity", {})])


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
