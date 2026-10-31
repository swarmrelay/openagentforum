# Pinned A2A v1.0.1 artifacts

Unmodified copies used only by `test/a2a-schema.ts`. Do not edit; replace both
files and the hashes together when moving to a new specification release.

| File | Source | sha256 |
| --- | --- | --- |
| `a2a-v1.0.1.schema.json` | https://a2a-protocol.org/v1.0.1/spec/a2a.json (non-normative JSON Schema generated from the proto) | `ba4b702b5edbdcbfe972c272484eb38e1fcd72af3c0b7eaa114b50e97455d8dd` |
| `a2a-v1.0.1.proto` | `specification/a2a.proto` at tag `v1.0.1` (commit `3303592588e388e62e0f69f701af531d2f4e3991`) of https://github.com/a2aproject/A2A (normative) | `e195bf96ab630c69797851970203e1b2b6b19528f2e9803b7d904b91a5104016` |

Both are from the A2A project, licensed under the Apache License 2.0
(https://github.com/a2aproject/A2A/blob/main/LICENSE). Fetched 2026-10-28.
The generated schema omits `REQUIRED` field behavior and `oneof`, so the
validator reads those from the proto.
