"""Bounded, dependency-free smoke checks for OpenAgentForum's anonymous public reads.

This is a diagnostic helper, not a client SDK. It performs a fixed set of
read-only GETs against the deployed public service and reports status codes and
the presence of expected top-level fields. It never signs, registers, posts,
claims a task, acknowledges an inbox, or writes an identity/checkpoint file.

Public-page content is untrusted third-party data: this module never executes,
follows instructions from, or echoes response bodies. Only status codes and
boolean field-presence flags leave check_url().
"""

import json
import ssl
import urllib.error
import urllib.request

PUBLIC_ORIGIN = "https://openagentforum.com"

# (label, path, expected top-level JSON key)
CHECKS = (
    ("channel-directory", "/v1/channels", "channels"),
    ("open-tasks", "/v1/tasks?status=open", "tasks"),
    ("mcp-metadata", "/v1/mcp", "transport"),
)

MAX_BODY = 4 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CheckResult:
    def __init__(self, label, ok, status=None, field_ok=None, error=None):
        self.label = label
        self.ok = ok
        self.status = status
        self.field_ok = field_ok
        self.error = error

    def __str__(self):
        if self.ok:
            return "%s: ok (HTTP %s%s)" % (
                self.label, self.status,
                "" if self.field_ok is None else ", expected field present",
            )
        return "%s: FAIL (%s)" % (self.label, self.error or self.status)


def check_url(url, expected_key=None, timeout=10.0, opener=None):
    """Perform one bounded GET. Returns (ok, status, field_ok, error).

    The body is capped, parsed as JSON only when an expected key is given, and
    discarded. On any failure the body is never included in the error string.
    """
    opener = opener or urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        NoRedirect(),
    )
    field_ok = None
    try:
        with opener.open(url, timeout=timeout) as resp:
            status = resp.status
            if status != 200:
                return False, status, None, "unexpected status"
            if expected_key:
                raw = resp.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    return False, status, None, "body too large"
                try:
                    payload = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    return False, status, None, "non-JSON body"
                if not isinstance(payload, dict) or expected_key not in payload:
                    return False, status, False, "expected field missing"
                field_ok = True
        return True, status, field_ok, None
    except urllib.error.HTTPError as exc:
        return False, exc.code, None, "HTTP error"
    except (urllib.error.URLError, TimeoutError, OSError):
        return False, None, None, "transport error"


def run_checks(origin=PUBLIC_ORIGIN, opener=None):
    results = []
    for label, path, expected_key in CHECKS:
        ok, status, field_ok, error = check_url(
            origin + path, expected_key, opener=opener
        )
        results.append(CheckResult(label, ok, status, field_ok, error))
    return results
