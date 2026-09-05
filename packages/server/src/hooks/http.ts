import { deriveHookId, validateHookSpec, type HookSpec } from '@openagentforum/protocol';
import { HookManager } from './manager.js';
import { HookError, type HookProof } from './types.js';

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key)); }
function parseProof(value: Record<string, unknown>): HookProof {
  if (typeof value.timestamp !== 'number' || !Number.isSafeInteger(value.timestamp) || typeof value.signature !== 'string' || !/^[a-f0-9]{128}$/.test(value.signature)) throw new HookError('invalid_proof', 401);
  return { timestamp: value.timestamp, signature: value.signature };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || request.headers.has('content-encoding')) throw new HookError('json_required', 400);
  if (Number(request.headers.get('content-length') ?? 0) > 12 * 1024) throw new HookError('body_too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new HookError('body_required', 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HookError('body_timeout', 408)), 2000); });
  try {
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 12 * 1024) throw new HookError('body_too_large', 413);
      chunks.push(part.value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
    catch { throw new HookError('invalid_json', 400); }
    if (!object(parsed)) throw new HookError('invalid_body', 400);
    return parsed;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Shared adapter entry: null means not a hook path; null manager means deliberately unavailable. */
export async function handleHookRequest(request: Request, manager: HookManager | null): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.match(/^\/v1\/agents\/(agent_[a-f0-9]{16})\/hooks(?:\/(hook_[a-f0-9]{16})(\/renew)?)?$/);
  if (!path) return null;
  const json = (value: object, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!manager) return json({ error: 'wake_hooks_unavailable', staged: true }, 501);
  const [, agentId, hookId, renew] = path;
  try {
    if (url.search) return json({ error: 'query_not_supported' }, 400);
    if (request.method === 'GET' && !hookId) {
      const timestamp = request.headers.get('x-agent-timestamp') ?? '';
      if (!/^\d+$/.test(timestamp)) throw new HookError('invalid_proof', 401);
      return json(await manager.list(agentId, parseProof({ timestamp: Number(timestamp), signature: request.headers.get('x-agent-signature') })));
    }
    const action = request.method === 'POST' && !hookId ? 'set' : request.method === 'POST' && renew ? 'renew' : request.method === 'DELETE' && hookId && !renew ? 'delete' : null;
    if (!action) return json({ error: 'method_not_allowed' }, 405);
    const input = await body(request);
    if (!keys(input, action === 'set' ? ['hook', 'timestamp', 'signature'] : ['timestamp', 'signature'])) throw new HookError('invalid_body', 400);
    const proof = parseProof(input);
    if (action === 'set') {
      const validated = validateHookSpec(input.hook);
      if (!validated.ok) throw new HookError('invalid_hook', 400);
      const id = await deriveHookId(agentId, validated.hook.url);
      // Validate the shape but verify the original signed spec, not a normalized replacement.
      const result = await manager.mutate({ action, agentId, hookId: id, hook: input.hook as HookSpec, ...proof });
      return json(result, result.alreadyApplied ? 200 : 202);
    }
    const result = await manager.mutate({ action, agentId, hookId: hookId!, ...proof });
    return json(result, action === 'renew' && !result.alreadyApplied ? 202 : 200);
  } catch (error) {
    return json({ error: error instanceof HookError ? error.code : 'wake_hooks_unavailable' }, error instanceof HookError ? error.status : 503);
  }
}
