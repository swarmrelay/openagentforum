import { deriveHookId, validateHookUrl, type WakeBody } from '@openagentforum/protocol';

export const MAX_JOB_BYTES = 8192;
export const JOB_FRESHNESS_MS = 60_000;

export interface DeliveryJob {
  /** Stable across transport retries to this service; new for a deliberate callback retry. */
  jobId: string;
  url: string;
  secret: string;
  body: WakeBody;
}

export type DeliveryCode = 'delivered' | 'verified' | 'unsafe_url' | 'unsafe_address' |
  'dns_failed' | 'timeout' | 'network_error' | 'tls_error' | 'http_error' |
  'response_too_large' | 'invalid_verification' | 'indeterminate';

/** No callback response bodies, URLs, secrets, or raw network errors cross this boundary. */
export interface DeliveryResult {
  ok: boolean;
  code: DeliveryCode;
  retryable: boolean;
  status?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function matches(value: unknown, re: RegExp): value is string {
  return typeof value === 'string' && re.test(value);
}

/** Strictly reconstruct a hint: never relay caller-supplied extra fields or message content. */
export async function parseJob(input: unknown, hub: string, now: number): Promise<DeliveryJob | null> {
  if (!record(input) || !exactKeys(input, ['jobId', 'url', 'secret', 'body'])) return null;
  if (!matches(input.jobId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)) return null;
  if (typeof input.url !== 'string' || typeof input.secret !== 'string' || input.secret.length < 32 || input.secret.length > 128) return null;
  const url = validateHookUrl(input.url);
  if (!url.ok || !record(input.body)) return null;
  const body = input.body;
  if (body.hub !== hub || !matches(body.agentId, /^agent_[a-f0-9]{16}$/) || !matches(body.hookId, /^hook_[a-f0-9]{16}$/)) return null;
  if (typeof body.sentAt !== 'number' || !Number.isSafeInteger(body.sentAt) || Math.abs(now - body.sentAt) > JOB_FRESHNESS_MS) return null;
  if (body.hookId !== await deriveHookId(body.agentId, url.url.toString())) return null;
  const common = ['kind', 'hub', 'hookId', 'agentId', 'sentAt'];
  const base = { hub, hookId: body.hookId, agentId: body.agentId, sentAt: body.sentAt };
  let hint: WakeBody;
  if (body.kind === 'verify') {
    if (!exactKeys(body, [...common, 'nonce']) || !matches(body.nonce, /^[a-f0-9]{64}$/)) return null;
    hint = { kind: 'verify', ...base, nonce: body.nonce };
  } else if (body.kind === 'wake') {
    if (!exactKeys(body, [...common, 'channel', 'storedSeq', 'envelopeId', 'sender', 'type', 'mentioned'])) return null;
    if (!matches(body.channel, /^[a-z0-9_-]{1,64}$/) || !matches(body.sender, /^agent_[a-f0-9]{16}$/) || !matches(body.type, /^[a-z_]{1,32}$/)) return null;
    if (typeof body.storedSeq !== 'number' || !Number.isSafeInteger(body.storedSeq) || body.storedSeq < 1 || typeof body.mentioned !== 'boolean') return null;
    // Protocol IDs may be UUIDs with or without the urn prefix; no free-text data channel.
    if (!matches(body.envelopeId, /^(?:urn:uuid:)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) return null;
    hint = { kind: 'wake', ...base, channel: body.channel, storedSeq: body.storedSeq, envelopeId: body.envelopeId, sender: body.sender, type: body.type, mentioned: body.mentioned };
  } else return null;
  return { jobId: input.jobId, url: url.url.toString(), secret: input.secret, body: hint };
}
