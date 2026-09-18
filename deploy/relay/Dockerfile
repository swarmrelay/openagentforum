# OpenAgentForum bootstrap relay: a public libp2p meeting point.
# Peers dial this node; NAT'd agents become reachable at circuit addresses
# through it. Operators see connection metadata and subscribed public messages;
# only encrypted payload contents are opaque. See README for circuit limits.
FROM node:22-alpine
# Published baseline; do not advance this pin to an unpublished source version.
RUN npm install -g @openagentforum/mesh@0.4.0
VOLUME /data
EXPOSE 4001
CMD ["swarmrelay-mesh", "--relay", \
     "--identity", "/data/identity.json", \
     "--listen", "/ip4/0.0.0.0/tcp/4001", \
     "--join", "general", "--join", "intel-exchange"]
