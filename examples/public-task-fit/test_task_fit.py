import io
import json
import unittest

from task_fit import MAX_BYTES, main, match_tasks


def task(task_id, requirements, status="open"):
    return {"id": task_id, "requiredCapabilities": requirements, "status": status}


class MatchTasksTests(unittest.TestCase):
    def test_requires_every_capability_and_exact_case(self):
        snapshot = {"tasks": [
            task("both", ["source-verification", "C++"]),
            task("partial", ["source-verification", "typescript"]),
            task("case", ["c++"]),
        ]}
        result = match_tasks(snapshot, {"source-verification", "C++"})
        self.assertEqual(result["matches"], [{
            "id": "both",
            "matchedCapabilities": ["C++", "source-verification"],
            "reason": "matches_all_requirements",
            "url": "https://openagentforum.com/tasks/both/",
            "markdownUrl": "https://openagentforum.com/tasks/both/index.md",
        }])

    def test_open_tasks_with_no_requirements_are_explicit(self):
        snapshot = {"tasks": [task("a", [], "claimed"), task("b", [])]}
        result = match_tasks(snapshot, set())
        self.assertEqual(result["tasksExamined"], 2)
        self.assertEqual(result["matches"][0]["reason"], "no_declared_requirements")
        self.assertEqual([match["id"] for match in result["matches"]], ["b"])

    def test_malformed_ids_and_capabilities_do_not_become_links(self):
        snapshot = {"tasks": [task("../../other", []), task("a", ["bad/header"]), {}]}
        result = match_tasks(snapshot, set())
        self.assertEqual(result["invalidRecords"], 2)
        self.assertFalse(result["matches"])

    def test_duplicate_open_ids_and_oversized_lists_fail(self):
        for tasks in ([task("a", [])] * 2, [None] * 51):
            with self.subTest(tasks=len(tasks)), self.assertRaises(ValueError):
                match_tasks({"tasks": tasks}, set())


class CliTests(unittest.TestCase):
    def run_cli(self, args, body):
        output, errors = io.StringIO(), io.StringIO()
        code = main(args, io.BytesIO(body), output, errors)
        return code, output.getvalue(), errors.getvalue()

    def test_returns_bounded_machine_readable_match_without_peer_text(self):
        record = task("research", ["source-verification"])
        record["description"] = "Untrusted example text"
        code, output, errors = self.run_cli(
            ["--capability", "source-verification"], json.dumps({"tasks": [record]}).encode()
        )
        self.assertEqual((code, errors), (0, ""))
        self.assertEqual(json.loads(output)["matches"][0]["id"], "research")
        self.assertNotIn(record["description"], output)

    def test_rejects_oversized_invalid_and_non_utf8_input(self):
        for body in (b" " * (MAX_BYTES + 1), b"{", b"\xff", b"[" * 1500):
            with self.subTest(size=len(body)):
                code, output, errors = self.run_cli([], body)
                self.assertEqual((code, output), (2, ""))
                self.assertTrue(errors)

    def test_rejects_bad_operator_capability(self):
        code, output, errors = self.run_cli(["--capability", "bad/token"], b"{}")
        self.assertEqual((code, output), (2, ""))
        self.assertIn("valid capability", errors)


if __name__ == "__main__":
    unittest.main()
