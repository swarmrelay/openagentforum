"""Offline tests for forum_tools, driven by an in-memory stub client.

No network: the stub records the forwarded calls and returns canned MCP
results, and PydanticAI's TestModel exercises the Agent + Tool wiring without
any LLM API credential.
"""

import asyncio
import unittest

from pydantic_ai import Agent, ModelRetry
from pydantic_ai.messages import ModelResponse, RetryPromptPart, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

from forum_tools import (
    MAX_CHANNEL_POSITION,
    READ_TOOL_NAMES,
    build_forum_tools,
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


def run_tool(tool, arguments):
    validated = tool.function_schema.validator.validate_python(arguments)
    return asyncio.run(tool.function(**validated))


class BuildForumToolsTests(unittest.TestCase):
    def setUp(self):
        self.client = StubClient(text_result("ok"))
        self.tools = {tool.name: tool for tool in build_forum_tools(self.client)}

    def test_tool_set_matches_published_read_tools(self):
        self.assertEqual(set(self.tools), set(READ_TOOL_NAMES))

    def test_schemas_expose_the_published_arguments(self):
        def properties(name):
            return set(self.tools[name].function_schema.json_schema["properties"])

        def required(name):
            return set(self.tools[name].function_schema.json_schema.get("required", []))

        self.assertEqual(properties("list_channels"), {"after"})
        self.assertEqual(properties("read_channel"), {"channel", "before"})
        self.assertEqual(properties("read_message"), {"channel", "message_id"})
        self.assertEqual(properties("recent_public_activity"), {"before", "after"})
        self.assertEqual(required("read_channel"), {"channel"})
        self.assertEqual(required("read_message"), {"channel", "message_id"})
        self.assertEqual(required("list_channels"), set())
        self.assertEqual(required("recent_public_activity"), set())

    def test_required_arguments_are_enforced(self):
        with self.assertRaises(Exception):
            run_tool(self.tools["read_channel"], {})
        self.assertEqual(self.client.calls, [])

    def test_invalid_bookmarks_are_rejected_before_calling_client(self):
        with self.assertRaises(ModelRetry):
            run_tool(self.tools["recent_public_activity"], {"before": "one", "after": "two"})
        for before in (0, MAX_CHANNEL_POSITION + 1, 1.5, True, "one"):
            with self.assertRaises(Exception):
                run_tool(self.tools["read_channel"], {"channel": "general", "before": before})
        self.assertEqual(self.client.calls, [])

    def test_arguments_forward_without_none_optionals(self):
        run_tool(self.tools["read_channel"], {"channel": "general"})
        self.assertEqual(self.client.calls, [("read_channel", {"channel": "general"})])

    def test_arguments_forward_with_optionals(self):
        run_tool(self.tools["list_channels"], {"after": "general"})
        run_tool(self.tools["read_channel"], {"channel": "general", "before": 42})
        run_tool(self.tools["read_message"], {"channel": "general", "message_id": "m-1"})
        self.assertEqual(
            self.client.calls,
            [
                ("list_channels", {"after": "general"}),
                ("read_channel", {"channel": "general", "before": 42}),
                ("read_message", {"channel": "general", "message_id": "m-1"}),
            ],
        )

    def test_tool_output_is_the_flattened_text(self):
        output = run_tool(self.tools["recent_public_activity"], {})
        self.assertEqual(output, "ok")
        self.assertEqual(self.client.calls, [("recent_public_activity", {})])

    def test_pydantic_ai_agent_invokes_tool_with_test_model(self):
        agent = Agent(
            TestModel(call_tools=["list_channels"], custom_output_text="listed"),
            tools=list(self.tools.values()),
        )
        result = asyncio.run(agent.run("List the channels"))
        self.assertEqual(result.output, "listed")
        self.assertEqual(self.client.calls, [("list_channels", {})])

    def test_conflicting_bookmarks_trigger_model_retry_and_recover(self):
        seen_feedback = []
        turn = 0

        def respond(messages, _info):
            nonlocal turn
            turn += 1
            if turn == 1:
                return ModelResponse(
                    parts=[
                        ToolCallPart(
                            tool_name="recent_public_activity",
                            args={"before": "one", "after": "two"},
                            tool_call_id="call-conflict",
                        )
                    ]
                )
            if turn == 2:
                self.assertEqual(self.client.calls, [])
                for message in messages:
                    for part in message.parts:
                        if isinstance(part, (RetryPromptPart, ToolReturnPart)):
                            seen_feedback.append(str(part.content))
                return ModelResponse(
                    parts=[
                        ToolCallPart(
                            tool_name="recent_public_activity",
                            args={"before": "one"},
                            tool_call_id="call-fixed",
                        )
                    ]
                )
            return ModelResponse(parts=[TextPart("recovered")])

        agent = Agent(FunctionModel(respond), tools=list(self.tools.values()))
        result = asyncio.run(agent.run("Check recent public activity"))
        self.assertEqual(result.output, "recovered")
        self.assertTrue(any("Choose before or after, not both" in text for text in seen_feedback))
        self.assertEqual(self.client.calls, [("recent_public_activity", {"before": "one"})])


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
