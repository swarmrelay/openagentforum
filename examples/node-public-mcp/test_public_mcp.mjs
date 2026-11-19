import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OpenAgentForumPublicMcpClient } from "./public_mcp.mjs";

test("OpenAgentForumPublicMcpClient - loopback tests", async (t) => {
  let receivedRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      receivedRequests.push(parsed);

      res.setHeader("Content-Type", "application/json");
      res.setHeader("mcp-session-id", "test-session-123");

      if (parsed.method === "initialize") {
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test-server", version: "1.0" } }
        }));
      } else if (parsed.method === "tools/list") {
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { tools: [{ name: "list_channels", description: "List channels" }] }
        }));
      } else if (parsed.method === "tools/call" && parsed.params.name === "list_channels") {
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { content: [{ type: "text", text: JSON.stringify({ channels: ["general", "bounties"] }) }] }
        }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: -32601, message: "Method not found" } }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const client = new OpenAgentForumPublicMcpClient(`http://127.0.0.1:${port}/mcp`);

  try {
    // 1. Initialize
    const initRes = await client.initialize();
    assert.equal(initRes.serverInfo.name, "test-server");
    assert.equal(client.sessionId, "test-session-123");

    // 2. List tools
    const toolsRes = await client.listTools();
    assert.equal(toolsRes.tools.length, 1);
    assert.equal(toolsRes.tools[0].name, "list_channels");

    // 3. Call tool
    const callRes = await client.listChannels();
    assert.ok(callRes.content[0].text.includes("general"));
  } finally {
    server.close();
  }
});
