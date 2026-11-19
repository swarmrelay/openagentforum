import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OpenAgentForumPublicMcpClient, MCP_PROTOCOL_VERSION } from "./public_mcp.mjs";

function startLoopbackServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` });
    });
  });
}

test("SSE framing (CRLF, non-JSON event skip, id line, multi-line data) and notifications/initialized", async () => {
  let sawInitializedNotification = false;

  const { server, url } = await startLoopbackServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      res.setHeader("mcp-session-id", "sse-sess-1");

      if (parsed.method === "notifications/initialized") {
        sawInitializedNotification = true;
        res.statusCode = 202;
        return res.end();
      }

      res.setHeader("Content-Type", "text/event-stream");
      if (parsed.method === "initialize") {
        const frame = [
          "id: 100",
          "event: message",
          `data: {"jsonrpc":"2.0","id":${parsed.id},"result":{"protocolVersion":"${MCP_PROTOCOL_VERSION}","capabilities":{"tools":{}},"serverInfo":{"name":"oaf-sse","version":"1.0"}}}`,
          "",
          "",
        ].join("\r\n");
        return res.end(frame);
      }

      if (parsed.method === "tools/call" && parsed.params.name === "list_channels") {
        const p0 = `data: not-json-keepalive`;
        const p1 = `data: {"jsonrpc":"2.0","id":99999,"result":{"ignored":true}}`;
        const p2 = [
          "id: 101",
          "event: message",
          `data: {"jsonrpc":"2.0",`,
          `data: "id":${parsed.id},"result":{"content":[{"type":"text","text":"[\\\"general\\\",\\\"dev\\\"]"}]}}`,
        ].join("\r\n");
        return res.end(`${p0}\r\n\r\n${p1}\r\n\r\n${p2}\r\n\r\n`);
      }

      res.statusCode = 404;
      res.end();
    });
  });

  try {
    const client = new OpenAgentForumPublicMcpClient(url);
    const initRes = await client.initialize();
    assert.equal(initRes.serverInfo.name, "oaf-sse");
    assert.equal(sawInitializedNotification, true);

    const chRes = await client.listChannels("cursor-1");
    assert.ok(chRes.content[0].text.includes("general"));
  } finally {
    server.close();
  }
});

test("recentPublicActivity passes opaque v1 cursor strings unchanged on the wire", async () => {
  const sampleCursor = "v1.5815f146a1b2c3d4e5f60718293a4b5c.3494";
  let capturedArgs = null;

  const { server, url } = await startLoopbackServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      capturedArgs = parsed.params?.arguments;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        result: { content: [{ type: "text", text: "{\"items\":[]}" }] },
      }));
    });
  });

  try {
    const client = new OpenAgentForumPublicMcpClient(url);
    await client.recentPublicActivity({ before: sampleCursor });
    assert.equal(capturedArgs.before, sampleCursor);
    assert.equal(typeof capturedArgs.before, "string");
    await assert.rejects(() => client.recentPublicActivity({ before: 12345 }), TypeError);
  } finally {
    server.close();
  }
});

test("Multibyte UTF-8 split across chunks is preserved without U+FFFD", async () => {
  const utf8Phrase = "Привет 🚀 — тест кодировки UTF-8";
  const jsonBuf = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: utf8Phrase }] },
    }),
    "utf8"
  );

  const { server, url } = await startLoopbackServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      const splitIdx = jsonBuf.indexOf(Buffer.from("🚀", "utf8")) + 2;
      res.write(jsonBuf.subarray(0, splitIdx));
      setTimeout(() => {
        res.end(jsonBuf.subarray(splitIdx));
      }, 10);
    });
  });

  try {
    const client = new OpenAgentForumPublicMcpClient(url);
    const res = await client.readChannel("general", 10);
    assert.equal(res.content[0].text, utf8Phrase);
    assert.ok(!res.content[0].text.includes("\uFFFD"));
  } finally {
    server.close();
  }
});

test("Oversized response is rejected cleanly", async () => {
  const { server, url } = await startLoopbackServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.write("x".repeat(2048));
      res.end();
    });
  });

  try {
    const client = new OpenAgentForumPublicMcpClient(url, { maxBytes: 512 });
    await assert.rejects(() => client.listTools(), /exceeded maximum size/);
  } finally {
    server.close();
  }
});

test("Protocol mismatch, isError, JSON-RPC error, mismatched id, and input validation", async () => {
  const { server, url } = await startLoopbackServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      if (parsed.method === "initialize") {
        return res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { protocolVersion: "2024-01-01", capabilities: { tools: {} } },
        }));
      }
      if (parsed.method === "tools/call" && parsed.params.name === "list_channels") {
        return res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { isError: true, content: [{ type: "text", text: "bad cursor" }] },
        }));
      }
      if (parsed.method === "tools/call" && parsed.params.name === "read_message") {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32602, message: "Not found" } }));
      }
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id + 99, result: {} }));
    });
  });

  try {
    assert.throws(() => new OpenAgentForumPublicMcpClient("https://evil.example.com/mcp"), /Endpoint must be/);

    const client = new OpenAgentForumPublicMcpClient(url);
    await assert.rejects(() => client.initialize(), /Unsupported MCP protocolVersion/);
    await assert.rejects(() => client.listChannels(), /isError: true/);
    await assert.rejects(() => client.callTool("post_intel", {}), /allowlist/);
    await assert.rejects(() => client.readChannel("general", 0), /must be an integer/);
    await assert.rejects(() => client.readMessage("general", "msg-1"), /JSON-RPC error \[-32602\]/);
    await assert.rejects(() => client.listTools(), /mismatched id/);
  } finally {
    server.close();
  }
});
