import { createMcpHandler } from '@modelcontextprotocol/server';
import { BoundedReadError, cancelBody, deadline, readBounded, REQUEST_BYTES, REQUEST_READ_MS, RESULT_BYTES, withSignal } from './bounds.js';
import { createPublicServer, type PublicReader } from './public-tools.js';

export type { PublicReader } from './public-tools.js';

export interface PublicMcpOptions {
  /** Explicit, canonical HTTPS origin. Never derive authority from request Host. */
  endpointOrigin: string;
  /** Optional exact browser origins. Origin-less server-side MCP clients work. */
  browserOrigins?: readonly string[];
  /** Trusted, public-policy-preserving reader. No caller headers are forwarded. */
  readPublic: PublicReader;
  /** Trusted host admission before body parsing or SDK work. No automatic retry. */
  admitRequest?: (signal: AbortSignal) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

function origin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.origin !== value) throw new Error('Canonical HTTPS origin required');
  return value;
}

const methods = new Set(['initialize', 'server/discover', 'ping', 'tools/list', 'tools/call', 'notifications/initialized']);

export function createPublicMcpHandler(options: PublicMcpOptions): (request: Request) => Promise<Response> {
  const endpoint = origin(options.endpointOrigin);
  const browserOrigins = new Set((options.browserOrigins ?? []).map(origin));
  const readPublic = options.readPublic;
  return async request => {
    const url = new URL(request.url);
    const callerOrigin = request.headers.get('origin');
    const allowed = callerOrigin !== null && browserOrigins.has(callerOrigin);
    const headers = new Headers({
      'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'vary': 'Origin',
    });
    if (allowed) {
      headers.set('access-control-allow-origin', callerOrigin);
      headers.set('access-control-allow-methods', 'POST, OPTIONS');
      headers.set('access-control-allow-headers', 'Content-Type, Accept, MCP-Protocol-Version, MCP-Method, MCP-Name');
      headers.set('access-control-expose-headers', 'MCP-Protocol-Version, Retry-After');
    }
    const error = (status: number, message: string, code = -32600) => {
      headers.set('content-type', 'application/json');
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), { status, headers });
    };
    if (url.origin !== endpoint || (request.headers.has('host') && request.headers.get('host') !== new URL(endpoint).host)) return error(403, 'Invalid host');
    if (callerOrigin !== null && !allowed) return error(403, 'Invalid origin');
    if (url.pathname !== '/mcp' || url.search) return error(404, 'Not found');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') { headers.set('allow', 'POST, OPTIONS'); return error(405, 'Method not allowed'); }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding')) return error(415, 'JSON required; content encoding unsupported');
    const declared = request.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > REQUEST_BYTES)) {
      cancelBody(request.body); return error(413, 'Request too large');
    }
    if (options.admitRequest) {
      const admission = deadline(2_000, request.signal);
      try {
        const result = await withSignal(options.admitRequest(admission.signal), admission.signal);
        if (typeof result?.allowed !== 'boolean' || !Number.isFinite(result.retryAfterSeconds)) throw new Error('Invalid host admission');
        if (!result.allowed) {
          cancelBody(request.body);
          headers.set('retry-after', String(Math.min(86400, Math.max(1, Math.ceil(result.retryAfterSeconds)))));
          return error(429, 'Public MCP capacity reached. Back off before retrying.');
        }
      } catch {
        cancelBody(request.body); headers.set('retry-after', '60');
        return error(503, 'Public MCP admission unavailable');
      } finally { admission.close(); }
    }
    const input = deadline(REQUEST_READ_MS, request.signal);
    let parsed: unknown;
    try { parsed = JSON.parse(await readBounded(request.body, REQUEST_BYTES, input.signal)); }
    catch (reason) {
      return reason instanceof BoundedReadError
        ? error(reason.kind === 'timeout' ? 408 : reason.kind === 'limit' ? 413 : 400, 'Invalid or incomplete request body')
        : error(400, 'Invalid JSON', -32700);
    } finally { input.close(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('method' in parsed) || typeof parsed.method !== 'string') return error(400, 'One MCP request required');
    // No subscriptions, roots, sampling, arbitrary resources, batch work or sessions.
    if (!methods.has(parsed.method)) return error(400, 'Unsupported method', -32601);
    const scope = deadline(7_000, request.signal);
    // The upstream fetch-native SDK owns the wire protocol. Origin/Host checks
    // above apply equally to both eras; no extra Workers framework is needed.
    const handler = createMcpHandler(() => createPublicServer(readPublic, scope.signal), {
      legacy: 'stateless', responseMode: 'auto', maxSubscriptions: 0, keepAliveMs: 0,
    });
    try {
      // Body was already bounded/parsed. Tie SDK transport teardown to our own
      // deadline as well as client disconnect, including the legacy SSE leg.
      const exchange = new Request(request.url, { method: 'POST', headers: request.headers, signal: scope.signal });
      const pending = handler.fetch(exchange, { parsedBody: parsed });
      void pending.then(response => { if (scope.signal.aborted) cancelBody(response.body); }, () => {});
      const response = await withSignal(pending, scope.signal);
      const body = response.body ? await readBounded(response.body, RESULT_BYTES, scope.signal) : null;
      // Only protocol response headers survive. Never forward cookies or cache state.
      for (const name of ['content-type', 'mcp-protocol-version', 'allow']) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response(body, { status: response.status, headers });
    } catch { return error(503, 'MCP request unavailable', -32603); }
    finally { scope.close(); await handler.close(); }
  };
}
