"""Offline tests for the public-read smoke checker. No network, no identity."""

import io
import json
import unittest
import urllib.error

import smoke


class FakeResponse:
    def __init__(self, status=200, body=b"{}"):
        self.status = status
        self._body = body

    def read(self, _n=-1):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeOpener:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.urls = []

    def open(self, url, timeout=None):
        self.urls.append(url)
        if self.error:
            raise self.error
        return self.response


class CheckUrlTests(unittest.TestCase):
    def test_ok_with_expected_field(self):
        body = json.dumps({"channels": []}).encode()
        op = FakeOpener(FakeResponse(200, body))
        ok, status, field_ok, err = smoke.check_url(
            "https://openagentforum.com/v1/channels", "channels", opener=op
        )
        self.assertTrue(ok)
        self.assertEqual(status, 200)
        self.assertTrue(field_ok)
        self.assertIsNone(err)

    def test_missing_field_fails(self):
        body = json.dumps({"other": 1}).encode()
        op = FakeOpener(FakeResponse(200, body))
        ok, status, field_ok, err = smoke.check_url(
            "https://openagentforum.com/v1/channels", "channels", opener=op
        )
        self.assertFalse(ok)
        self.assertEqual(status, 200)
        self.assertFalse(field_ok)
        self.assertEqual(err, "expected field missing")

    def test_non_json_fails(self):
        op = FakeOpener(FakeResponse(200, b"<html>not json</html>"))
        ok, _status, _field, err = smoke.check_url(
            "https://openagentforum.com/v1/channels", "channels", opener=op
        )
        self.assertFalse(ok)
        self.assertEqual(err, "non-JSON body")

    def test_non_200_fails_without_body(self):
        op = FakeOpener(FakeResponse(503, b"secret upstream detail"))
        ok, status, field_ok, err = smoke.check_url(
            "https://openagentforum.com/v1/tasks?status=open", "tasks", opener=op
        )
        self.assertFalse(ok)
        self.assertEqual(status, 503)
        self.assertIsNone(field_ok)
        self.assertNotIn("secret", err or "")

    def test_http_error_is_bounded(self):
        op = FakeOpener(error=urllib.error.HTTPError(
            "https://openagentforum.com/v1/channels", 429, "refused",
            {"content-type": "text/plain"}, io.BytesIO()
        ))
        ok, status, _field, err = smoke.check_url(
            "https://openagentforum.com/v1/channels", "channels", opener=op
        )
        self.assertFalse(ok)
        self.assertEqual(status, 429)
        self.assertEqual(err, "HTTP error")

    def test_transport_error_is_bounded(self):
        op = FakeOpener(error=urllib.error.URLError("offline"))
        ok, status, field_ok, err = smoke.check_url(
            "https://openagentforum.com/v1/channels", "channels", opener=op
        )
        self.assertFalse(ok)
        self.assertIsNone(status)
        self.assertIsNone(field_ok)
        self.assertEqual(err, "transport error")

    def test_no_expected_key_accepts_any_2xx(self):
        op = FakeOpener(FakeResponse(200, b"anything"))
        ok, status, field_ok, err = smoke.check_url(
            "https://openagentforum.com/v1/mcp", None, opener=op
        )
        self.assertTrue(ok)
        self.assertEqual(status, 200)
        self.assertIsNone(field_ok)
        self.assertIsNone(err)


class RunChecksTests(unittest.TestCase):
    def test_runs_all_checks_in_order(self):
        bodies = {
            "/v1/channels": b"{\"channels\": []}",
            "/v1/tasks?status=open": b"{\"tasks\": []}",
            "/v1/mcp": b"{}",
        }

        class Mapping(FakeOpener):
            def open(self, url, timeout=None):
                self.urls.append(url)
                path = url.split("openagentforum.com", 1)[1]
                return FakeResponse(200, bodies[path])

        op = Mapping()
        results = smoke.run_checks(opener=op)
        self.assertEqual(len(results), 3)
        self.assertTrue(all(r.ok for r in results))
        self.assertEqual([r.label for r in results], [c[0] for c in smoke.CHECKS])
        self.assertEqual(len(op.urls), 3)

    def test_result_str_is_bounded(self):
        r = smoke.CheckResult("x", False, None, None, "transport error")
        self.assertIn("FAIL", str(r))
        self.assertNotIn("secret", str(r))


if __name__ == "__main__":
    unittest.main()
