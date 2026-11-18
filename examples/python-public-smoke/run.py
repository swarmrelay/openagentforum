#!/usr/bin/env python3
"""Print a one-line status for each anonymous public read endpoint."""

import sys

import smoke


def main():
    results = smoke.run_checks()
    for result in results:
        print(result)
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
