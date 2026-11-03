#!/usr/bin/env python3
"""Stdlib-only unit tests for oaf_py.

Mocks ``subprocess.run`` (for the fail-closed signed-operation paths) and
``urllib.request.urlopen`` (for the read-only REST paths), so no network or
Node.js install is required to run them.
"""
import io
import json
import subprocess
import unittest
from unittest import mock

import oaf_py
from oaf_py import OAF, VerificationError


def _fake_run(stdout="", returncode=0, stderr=""):
    return mock.patch(
        "subprocess.run",
        return_value=subprocess.CompletedProcess(
            ["npx", "-y", "swarmrelay@1.8.3"], returncode, stdout, stderr,
        ),
    )


class SignedOpsTests(unittest.TestCase):
    def test_swarm_raises_on_nonzero(self):
        with _fake_run(returncode=2, stderr="bad envelope") as run:
            with self.assertRaises(VerificationError):
                OAF()._swarm("verify", "general", "--hub", "https://openagentforum.com")
        run.assert_called_once()

    def test_swarm_pins_cli_and_passes_hub_env(self):
        with _fake_run(stdout="ok") as run:
            out = OAF(hub="http://localhost:8787")._swarm("hello", "--name", "X")
        self.assertEqual(out, "ok")
        _, kwargs = run.call_args
        cmd = kwargs["capture_output"] and run.call_args[0][0]
        self.assertEqual(cmd, ["npx", "-y", "swarmrelay@1.8.3", "hello", "--name", "X"])
        self.assertEqual(kwargs["env"]["SWARM_HUB_URL"], "http://localhost:8787")

    def test_post_inserts_double_dash(self):
        with _fake_run(stdout="ok") as run:
            OAF().post("general", "-not-a-flag")
        cmd = run.call_args[0][0]
        self.assertEqual(cmd[-4:], ["post", "--", "general", "-not-a-flag"])

    def test_reply_inserts_double_dash(self):
        with _fake_run(stdout="ok") as run:
            OAF().reply("general", "abc-123", "-starts-with-dash")
        cmd = run.call_args[0][0]
        self.assertEqual(cmd[-5:], ["reply", "--", "general", "abc-123", "-starts-with-dash"])

    def test_verify_passes_hub_flag(self):
        with _fake_run(stdout="ok") as run:
            OAF(hub="https://staging.example.com").verify("general")
        cmd = run.call_args[0][0]
        self.assertIn("--hub", cmd)
        self.assertEqual(cmd[cmd.index("--hub") + 1], "https://staging.example.com")


class ReadOnlyTests(unittest.TestCase):
    def test_messages_url_encodes_channel(self):
        rec = {"messages": [{"sender": "agent_a", "payload": {"message": "hi"}}]}
        body = json.dumps(rec).encode()
        with mock.patch("urllib.request.urlopen", return_value=io.BytesIO(body)) as urlopen:
            msgs = OAF().messages("my channel/with spaces")
        self.assertEqual(msgs, rec["messages"])
        req = urlopen.call_args[0][0]
        self.assertIn("/v1/channels/my%20channel%2Fwith%20spaces/messages", req.full_url)

    def test_messages_returns_empty_list(self):
        rec = {"messages": []}
        body = json.dumps(rec).encode()
        with mock.patch("urllib.request.urlopen", return_value=io.BytesIO(body)):
            self.assertEqual(OAF().messages("general"), [])

    def test_agent_url_encodes_id(self):
        body = json.dumps({"agent": {"agentId": "agent_1"}}).encode()
        with mock.patch("urllib.request.urlopen", return_value=io.BytesIO(body)) as urlopen:
            OAF().agent("agent_1/2")
        req = urlopen.call_args[0][0]
        self.assertIn("/v1/agents/agent_1%2F2", req.full_url)

    def test_custom_hub_is_used(self):
        body = json.dumps({"ok": True}).encode()
        with mock.patch("urllib.request.urlopen", return_value=io.BytesIO(body)) as urlopen:
            OAF(hub="http://localhost:8787").status()
        req = urlopen.call_args[0][0]
        self.assertTrue(req.full_url.startswith("http://localhost:8787/v1/status"))


if __name__ == "__main__":
    unittest.main()