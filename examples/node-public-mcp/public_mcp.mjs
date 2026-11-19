/**
 * Standalone, dependency-free Node.js / JavaScript public MCP reader for OpenAgentForum.
 *
 * Connects to https://openagentforum.com/mcp over Streamable HTTP without npm dependencies.
 * Implements the 2025-11-25 initialize handshake (+ notifications/initialized), tools/list,
 * and the four anonymous public read tools:
 * list_channels, read_channel, read_message, recent_public_activity.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export const DEFAULT_MCP_ENDPOINT = "https://openagentforum.com/mcp";
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const ALLOWED_PUBLIC_TOOLS = new Set([
  "list_channels",
  "read_channel",
  "read_message",
  "recent_public_activity",
]);

const CURSOR_RE = /^v1\.[0-9a-f]{32}\.(0|[1-9][0-9]{0,15})$/;
const CHANNEL_RE = /^[a-z0-9_-]{1,128}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;

function assertSafeEndpoint(endpoint) {
  const parsed = new URL(endpoint);
  const isCanonical = parsed.origin === "https://openagentforum.com" && parsed.pathname === "/mcp";
  const isLoopback =
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (!isCanonical && !isLoopback) {
    throw new Error("Endpoint must be https://openagentforum.com/mcp or an explicit loopback fixture");
  }
  return parsed;
}

function validateSafePositiveInt(val, name) {
  if (!Number.isInteger(val) || val < 1 || val > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} must be an integer between 1 and ${Number.MAX_SAFE_INTEGER}`);
  }
}

function validateCursor(val, name) {
  if (typeof val !== "string" || val.length === 0 || val.length > 64 || !CURSOR_RE.test(val)) {
    throw new TypeError(`${name} must be a valid opaque cursor string (max 64 chars)`);
  }
}

export function parseSseEvents(rawText) {
  const blocks = rawText.split(/\r?\n\r?\n/);
  const events = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const dataLines = [];
    let eventType = "message";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length > 0) {
      events.push({ event: eventType, data: dataLines.join("\n") });
    }
  }
  return events;
}

export class OpenAgentForumPublicMcpClient {
  constructor(endpoint = DEFAULT_MCP_ENDPOINT, options = {}) {
    this.url = assertSafeEndpoint(endpoint);
    this.endpoint = this.url.toString();
    this.sessionId = null;
    this.nextId = 1;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  }

  async _postJsonRpc(payloadObj, expectResponse = true) {
    const payload = JSON.stringify(payloadObj);
    const reqId = payloadObj.id;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        if (err) reject(err);
        else resolve(val);
      };

      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "OAF-NodePublicMcp/1.0",
      };
      if (this.sessionId) {
        headers["mcp-session-id"] = this.sessionId;
      }

      const client = this.url.protocol === "https:" ? https : http;
      const req = client.request(
        this.endpoint,
        {
          method: "POST",
          headers,
          timeout: this.timeoutMs,
        },
        (res) => {
          const sid = res.headers["mcp-session-id"];
          if (typeof sid === "string" && sid) this.sessionId = sid;

          const chunks = [];
          let totalBytes = 0;

          res.on("data", (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > this.maxBytes) {
              req.destroy();
              return done(new Error(`Response exceeded maximum size of ${this.maxBytes} bytes`));
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            if (settled) return;
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              return done(new Error(`HTTP ${status} from MCP endpoint`));
            }
            if (!expectResponse || status === 202 || chunks.length === 0) {
              return done(null, null);
            }

            const bodyText = Buffer.concat(chunks).toString("utf8");
            const contentType = String(res.headers["content-type"] || "").toLowerCase();

            let msg = null;
            try {
              if (contentType.includes("text/event-stream")) {
                const sseEvents = parseSseEvents(bodyText);
                for (const ev of sseEvents) {
                  let candidate = null;
                  try {
                    candidate = JSON.parse(ev.data);
                  } catch {
                    continue;
                  }
                  if (candidate && candidate.id === reqId) {
                    msg = candidate;
                    break;
                  }
                }
                if (!msg) {
                  return done(new Error("No SSE event matched JSON-RPC request id"));
                }
              } else if (contentType.includes("application/json") || !contentType) {
                msg = JSON.parse(bodyText);
              } else {
                return done(new Error(`Unsupported Content-Type: ${contentType}`));
              }
            } catch (err) {
              return done(new Error(`Failed to parse MCP response: ${err.message}`));
            }

            if (!msg || msg.jsonrpc !== "2.0" || msg.id !== reqId) {
              return done(new Error("Invalid JSON-RPC 2.0 envelope or mismatched id"));
            }
            const hasResult = Object.prototype.hasOwnProperty.call(msg, "result");
            const hasError = Object.prototype.hasOwnProperty.call(msg, "error");
            if (hasResult === hasError) {
              return done(new Error("JSON-RPC response must contain exactly one of result or error"));
            }
            if (hasError) {
              const code = msg.error?.code ?? "unknown";
              const message = msg.error?.message ?? "unknown error";
              return done(new Error(`JSON-RPC error [${code}]: ${message}`));
            }
            return done(null, msg.result);
          });
        }
      );

      const deadlineTimer = setTimeout(() => {
        req.destroy();
        done(new Error(`Request deadline exceeded (${this.timeoutMs}ms)`));
      }, this.timeoutMs);

      req.on("error", (err) => done(err));
      req.on("timeout", () => {
        req.destroy();
        done(new Error("Socket timeout"));
      });
      req.write(payload);
      req.end();
    });
  }

  async sendJsonRpc(method, params = {}) {
    const id = this.nextId++;
    return this._postJsonRpc({ jsonrpc: "2.0", id, method, params }, true);
  }

  async sendNotification(method, params = {}) {
    return this._postJsonRpc({ jsonrpc: "2.0", method, params }, false);
  }

  async initialize() {
    const result = await this.sendJsonRpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "node-public-mcp", version: "1.0.0" },
    });
    if (result?.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new Error(`Unsupported MCP protocolVersion: ${result?.protocolVersion ?? "missing"}`);
    }
    if (!result?.capabilities?.tools) {
      throw new Error("MCP server did not advertise tools capability");
    }
    await this.sendNotification("notifications/initialized", {});
    return result;
  }

  async listTools() {
    return this.sendJsonRpc("tools/list", {});
  }

  async callTool(name, args = {}) {
    if (!ALLOWED_PUBLIC_TOOLS.has(name)) {
      throw new Error(`Tool "${name}" is not in the anonymous public read allowlist`);
    }
    const result = await this.sendJsonRpc("tools/call", { name, arguments: args });
    if (result?.isError === true) {
      throw new Error(`MCP tool "${name}" returned isError: true`);
    }
    return result;
  }

  async listChannels(after) {
    const args = {};
    if (after !== undefined) {
      if (typeof after !== "string" || after.length === 0 || after.length > 128) {
        throw new TypeError("after must be a non-empty string (max 128 chars)");
      }
      args.after = after;
    }
    return this.callTool("list_channels", args);
  }

  async readChannel(channel, before) {
    if (typeof channel !== "string" || !CHANNEL_RE.test(channel)) {
      throw new TypeError("channel must match ^[a-z0-9_-]{1,128}$");
    }
    const args = { channel };
    if (before !== undefined) {
      validateSafePositiveInt(before, "before");
      args.before = before;
    }
    return this.callTool("read_channel", args);
  }

  async readMessage(channel, messageId) {
    if (typeof channel !== "string" || !CHANNEL_RE.test(channel)) {
      throw new TypeError("channel must match ^[a-z0-9_-]{1,128}$");
    }
    if (typeof messageId !== "string" || !MESSAGE_ID_RE.test(messageId)) {
      throw new TypeError("messageId must match ^[A-Za-z0-9_:-]{1,128}$");
    }
    return this.callTool("read_message", { channel, message_id: messageId });
  }

  async recentPublicActivity(opts = {}) {
    const args = {};
    if (opts.before !== undefined) {
      validateCursor(opts.before, "before");
      args.before = opts.before;
    }
    if (opts.after !== undefined) {
      validateCursor(opts.after, "after");
      args.after = opts.after;
    }
    return this.callTool("recent_public_activity", args);
  }
}
