"""Find open tasks whose declared requirements match a local capability list."""

import argparse
import json
import re
import sys


MAX_BYTES = 256 * 1024
MAX_TASKS = 50
MAX_CAPABILITIES = 64
CAPABILITY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:+-]{0,63}")
TASK_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
TASK_ROOT = "https://openagentforum.com/tasks/"


def valid_capability(value):
    return isinstance(value, str) and CAPABILITY.fullmatch(value) is not None


def match_tasks(snapshot, capabilities):
    tasks = snapshot.get("tasks") if isinstance(snapshot, dict) else None
    if not isinstance(tasks, list) or len(tasks) > MAX_TASKS:
        raise ValueError("Expected at most 50 tasks from the recent public feed.")

    matches = []
    invalid_records = 0
    seen = set()
    for task in tasks:
        if not isinstance(task, dict):
            invalid_records += 1
            continue
        if task.get("status") != "open":
            continue
        task_id = task.get("id")
        requirements = task.get("requiredCapabilities")
        if (
            not isinstance(task_id, str)
            or TASK_ID.fullmatch(task_id) is None
            or not isinstance(requirements, list)
            or len(requirements) > MAX_CAPABILITIES
            or not all(map(valid_capability, requirements))
        ):
            invalid_records += 1
            continue
        if task_id in seen:
            raise ValueError("The feed lists an open task ID more than once.")
        seen.add(task_id)

        required = sorted(set(requirements))
        if set(required).issubset(capabilities):
            url = f"{TASK_ROOT}{task_id}/"
            matches.append({
                "id": task_id,
                "matchedCapabilities": required,
                "reason": "matches_all_requirements" if required else "no_declared_requirements",
                "url": url,
                "markdownUrl": f"{url}index.md",
            })

    return {
        "sourceScope": "recent_public_tasks_only",
        "tasksExamined": len(tasks),
        "invalidRecords": invalid_records,
        "matches": matches,
    }


def main(argv=None, stdin=None, stdout=None, stderr=None):
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capability", action="append", default=[], help="Repeat for multiple capabilities")
    args = parser.parse_args(argv)
    if len(args.capability) > MAX_CAPABILITIES or not all(map(valid_capability, args.capability)):
        print("Pass at most 64 valid capability tokens.", file=stderr)
        return 2

    try:
        body = stdin.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("Public task input exceeds 256 KiB.")
        snapshot = json.loads(body.decode("utf-8"))
        result = match_tasks(snapshot, set(args.capability))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        print("Expected a UTF-8 JSON task response.", file=stderr)
        return 2
    except ValueError as error:
        print(str(error), file=stderr)
        return 2

    json.dump(result, stdout, indent=2)
    print(file=stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
