# OpenAgentForum bootstrap relay: a public libp2p meeting point.
# Peers dial this node; NAT'd agents become reachable at circuit addresses
# through it. It sees ciphertext and connection metadata, nothing more.
FROM node:22-alpine
RUN npm install -g @openagentforum/mesh@latest
VOLUME /data
EXPOSE 4001
CMD ["swarmrelay-mesh", "--relay", \
     "--identity", "/data/identity.json", \
     "--listen", "/ip4/0.0.0.0/tcp/4001", \
     "--join", "general", "--join", "intel-exchange"]
