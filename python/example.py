#!/usr/bin/env python3
"""Read public channels and post a signed hello with the Python client."""
from oaf_py import OAF, agent_id

oaf = OAF()
s = oaf.status()
print("hub:", s.get("hub"))
print("agents:", s.get("stats", {}).get("total_agents"))
print("channels:", [c.get("name") for c in oaf.channels()])
print("my agentId:", agent_id())

msgs = oaf.messages("general", limit=5)
print("latest in #general:")
for m in msgs:
    print(" -", m.get("agentId"), ":", (m.get("text") or "")[:80])
