"""Offline tests for forum_tools, driven by an in-memory stub client.

No network: the stub records the forwarded calls and returns canned MCP
results, so these tests pin the adapter contract (tool set, argument
forwarding, content flattening) without touching the live service. The tools
are synchronous, so the tests call ``_run`` directly and validate argument
schemas through each tool's ``args_schema`` model, which is where CrewAI
enforces them before a call.
"""

import unittest

from forum_tools import (
    READ_TOOL_NAMES,
    build_forum_tools,
    close_forum_tools,
    flatten_tool_result,
)


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

    def tearDown(self):
        close_forum_tools(list(self.tools.values()))

    def test_tool_set_matches_published_read_tools(self):
        self.assertEqual(set(self.tools), set(READ_TOOL_NAMES))

    def test_schemas_expose_the_published_arguments(self):
        fields = {name: set(tool.args_schema.model_fields) for name, tool in self.tools.items()}
        self.assertEqual(fields["list_channels"], {"after"})
        self.assertEqual(fields["read_channel"], {"channel", "before"})
        self.assertEqual(fields["read_message"], {"channel", "message_id"})
        self.assertEqual(fields["recent_public_activity"], {"before", "after"})
        self.assertEqual(self.tools["read_message"].args_schema.model_fields["message_id"].annotation, str)

    def test_required_arguments_are_enforced(self):
        with self.assertRaises(Exception):
            self.tools["read_channel"].args_schema.model_validate({})

    def test_invalid_bookmarks_are_rejected_by_the_schema(self):
        with self.assertRaises(Exception):
            self.tools["recent_public_activity"].args_schema.model_validate(
                {"before": "one", "after": "two"}
            )
        for before in (0, 9007199254740992, 1.5):
            with self.assertRaises(Exception):
                self.tools["read_channel"].args_schema.model_validate(
                    {"channel": "general", "before": before}
                )
        self.assertEqual(self.client.calls, [])

    def test_arguments_forward_without_none_optionals(self):
        self.tools["read_channel"]._run(channel="general")
        self.assertEqual(self.client.calls, [("read_channel", {"channel": "general"})])

    def test_arguments_forward_with_optionals(self):
        self.tools["list_channels"]._run(after="general")
        self.tools["read_channel"]._run(channel="general", before=42)
        self.tools["read_message"]._run(channel="general", message_id="m-1")
        self.assertEqual(
            self.client.calls,
            [
                ("list_channels", {"after": "general"}),
                ("read_channel", {"channel": "general", "before": 42}),
                ("read_message", {"channel": "general", "message_id": "m-1"}),
            ],
        )

    def test_tool_output_is_the_flattened_text(self):
        output = self.tools["recent_public_activity"]._run()
        self.assertEqual(output, "ok")
        self.assertEqual(self.client.calls, [("recent_public_activity", {})])

    def test_tool_set_shares_one_loop_thread(self):
        threads = {id(tool._loop_thread) for tool in self.tools.values()}
        self.assertEqual(len(threads), 1)


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
