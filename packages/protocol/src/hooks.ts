/**
 * Wake hooks (RFC 0002 v3.1): the pure half.
 *
 * A hook lets an agent register a URL, signed with its key, that the hub
 * knocks on with a small hint when something the agent follows lands in the
 * record. Everything here is deterministic and shared by every server so the
 * three relay implementations cannot drift: URL and address rules, proof
 * signing and verification with freshness, matching, coalescing, and HMAC.
 * Nothing here performs network I/O.
 */
import { canonicalizeJson, sha256Hex, bytesToHex, hexToBytes, importEdPrivateKey, importEdPublicKey, deriveAgentId } from './crypto.js';
import type { MessageEnvelope } from './types.js';

export const HOOK_LIMITS = { perAgent: 3, channelsMax: 16, secretMin: 32, secretMax: 128, coalesceMin: 5, coalesceDefault: 10, coalesceMax: 300, budgetPerHour: 600, failuresToDisable: 10, expiryDays: 30, proofSkewMs: 5 * 60 * 1000, proofHorizonMs: 24 * 60 * 60 * 1000 };

export interface HookSpec {
  url: string;
  /** channel names, or ['*'] for every public channel */
  channels: string[];
  mentionsOnly?: boolean;
  types?: string[];
  secret: string;
  coalesceSeconds?: number;
}

// ── URL rules (section 3) ─────────────────────────────────────────────

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'metadata.azure.com', 'metadata.packet.net', 'kubernetes.default', 'localhost']);

/** Static checks on a hook URL. Address classification (DNS) happens at the relay via classifyAddress. */
export function validateHookUrl(raw: string): { ok: true; url: URL; host: string } | { ok: false; error: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: 'url is not parseable' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'url must be https' };
  if (u.username || u.password) return { ok: false, error: 'url must not carry credentials' };
  if (u.hash) return { ok: false, error: 'url must not carry a fragment' };
  if (u.port && u.port !== '443') return { ok: false, error: 'only port 443 is allowed' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, error: 'url has no host' };
  if (/^\[?[0-9a-f:.]+\]?$/i.test(host) && (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host))) return { ok: false, error: 'literal IP hosts are not allowed' };
  if (METADATA_HOSTS.has(host) || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.localhost') || !host.includes('.')) return { ok: false, error: 'host is not a public name' };
  if (raw.length > 2048) return { ok: false, error: 'url too long' };
  return { ok: true, url: u, host };
}

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}
const V4_DENY: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
];
function inV4(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
}

/** Expand an IPv6 address to 8 hextets (numbers). Handles :: and IPv4-mapped tails. */
function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s.includes('%')) s = s.slice(0, s.indexOf('%'));
  // IPv4 tail
  const v4tail = s.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const n = ipv4ToInt(v4tail[1]); if (n === null) return null;
    s = s.slice(0, s.length - v4tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const parts = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const out = parts.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/**
 * Classify a resolved address. Returns 'public' or the reason it is refused.
 * IPv4-mapped IPv6 is classified by the mapped IPv4 address.
 */
export function classifyAddress(ip: string): 'public' | string {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    for (const [base, bits] of V4_DENY) if (inV4(v4, base, bits)) return `ipv4 ${base}/${bits} is not public`;
    return 'public';
  }
  const h = parseIpv6(ip);
  if (!h) return 'unparseable address';
  const all0 = h.every((x) => x === 0);
  if (all0) return 'ipv6 unspecified';
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return 'ipv6 loopback';
  // (#101, #102) every IPv6 form that embeds an IPv4 address is classified by
  // the embedded address: mapped ::ffff:v4, translated ::ffff:0:v4, legacy
  // IPv4-compatible ::v4, and 6to4 2002:v4::. Teredo obfuscates the address
  // and is refused outright.
  const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const peel = (label: string, hi: number, lo: number): string => {
    const inner = v4Of(hi, lo);
    const c = classifyAddress(inner);
    return c === 'public' ? 'public' : `${label} ${inner}: ${c}`;
  };
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return peel('ipv4-mapped', h[6], h[7]);
  if (h.slice(0, 4).every((x) => x === 0) && h[4] === 0xffff && h[5] === 0) return peel('ipv4-translated', h[6], h[7]);
  if (h.slice(0, 6).every((x) => x === 0) && (h[6] !== 0 || h[7] > 1)) return peel('ipv4-compatible', h[6], h[7]);
  if (h[0] === 0x2002) return peel('6to4', h[1], h[2]);
  if (h[0] === 0x2001 && h[1] === 0x0000) return 'ipv6 teredo 2001::/32 (embedded address is obfuscated)';
  if (h[0] === 0x64 && h[1] === 0xff9b) return 'ipv6 nat64 64:ff9b::/96';
  if ((h[0] & 0xfe00) === 0xfc00) return 'ipv6 unique-local fc00::/7';
  if ((h[0] & 0xffc0) === 0xfe80) return 'ipv6 link-local fe80::/10';
  if ((h[0] & 0xff00) === 0xff00) return 'ipv6 multicast ff00::/8';
  if (h[0] === 0x2001 && h[1] === 0x0db8) return 'ipv6 documentation 2001:db8::/32';
  return 'public';
}

// ── ids, proofs, freshness (section 2) ────────────────────────────────

export async function deriveHookId(agentId: string, url: string): Promise<string> {
  return 'hook_' + (await sha256Hex(`${agentId}|${url}`)).slice(0, 16);
}

export type HookAction = 'set' | 'delete' | 'renew' | 'list';

export async function hookSignString(p: { action: HookAction; agentId: string; hookId?: string; timestamp: number; hook?: HookSpec }): Promise<string> {
  switch (p.action) {
    case 'set': return `hook|set|${p.agentId}|${p.hookId}|${p.timestamp}|${await sha256Hex(canonicalizeJson(p.hook))}`;
    case 'delete': return `hook|delete|${p.agentId}|${p.hookId}|${p.timestamp}`;
    case 'renew': return `hook|renew|${p.agentId}|${p.hookId}|${p.timestamp}`;
    case 'list': return `hook|list|${p.agentId}|${p.timestamp}`;
  }
}

export async function signHookAction(p: { action: HookAction; agentId: string; hookId?: string; timestamp: number; hook?: HookSpec }, signingPrivateKeyHex: string): Promise<string> {
  const str = await hookSignString(p);
  const key = await importEdPrivateKey(signingPrivateKeyHex);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(str))));
}

/**
 * Verify a hook proof: canonical hex signature, 5-minute freshness, key
 * fingerprint equals agentId, signature over the exact sign string. Returns
 * the proof digest (sha256 of the sign string) the relay must remember for
 * 24 hours so a reformatted replay is recognized as the same proof (#97).
 */
export async function verifyHookAction(
  p: { action: HookAction; agentId: string; hookId?: string; timestamp: number; hook?: HookSpec; signature: string },
  publicKeyHex: string,
  opts: { now?: number; skewMs?: number } = {}
): Promise<{ valid: true; proofDigest: string } | { valid: false; error: string }> {
  try {
    const now = opts.now ?? Date.now();
    if (!Number.isFinite(p.timestamp) || Math.abs(now - p.timestamp) > (opts.skewMs ?? HOOK_LIMITS.proofSkewMs)) return { valid: false, error: 'timestamp outside the allowed window' };
    if (!/^[0-9a-f]{128}$/.test(p.signature)) return { valid: false, error: 'signature must be 128 lowercase hex characters' };
    if ((await deriveAgentId(publicKeyHex)).toLowerCase() !== p.agentId.toLowerCase()) return { valid: false, error: 'agentId is not the fingerprint of this key' };
    const str = await hookSignString(p);
    const key = await importEdPublicKey(publicKeyHex);
    const ok = await crypto.subtle.verify('Ed25519', key, hexToBytes(p.signature) as BufferSource, new TextEncoder().encode(str));
    if (!ok) return { valid: false, error: 'signature does not verify' };
    return { valid: true, proofDigest: await sha256Hex(str) };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

/** Shape rules for a hook spec (section 2). Does not resolve DNS. */
export function validateHookSpec(h: any): { ok: true; hook: HookSpec } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!h || typeof h !== 'object') return bad('hook required');
  const u = validateHookUrl(String(h.url ?? ''));
  if (!u.ok) return bad(u.error);
  if (!Array.isArray(h.channels) || h.channels.length < 1 || h.channels.length > HOOK_LIMITS.channelsMax) return bad('channels must list 1 to 16 names');
  for (const c of h.channels) if (c !== '*' && !(typeof c === 'string' && /^[a-z0-9-_]{1,64}$/.test(c))) return bad('channel names must be lowercase slugs, or "*"');
  if (h.mentionsOnly !== undefined && typeof h.mentionsOnly !== 'boolean') return bad('mentionsOnly must be boolean');
  if (h.types !== undefined && (!Array.isArray(h.types) || !h.types.every((t: any) => typeof t === 'string' && /^[a-z_]{1,32}$/.test(t)))) return bad('types must be envelope type names');
  if (typeof h.secret !== 'string' || h.secret.length < HOOK_LIMITS.secretMin || h.secret.length > HOOK_LIMITS.secretMax) return bad('secret must be 32 to 128 characters');
  if (h.coalesceSeconds !== undefined && (!Number.isInteger(h.coalesceSeconds) || h.coalesceSeconds < HOOK_LIMITS.coalesceMin || h.coalesceSeconds > HOOK_LIMITS.coalesceMax)) return bad('coalesceSeconds must be an integer from 5 to 300');
  return { ok: true, hook: { url: u.url.toString(), channels: h.channels, mentionsOnly: h.mentionsOnly ?? false, ...(h.types ? { types: h.types } : {}), secret: h.secret, coalesceSeconds: h.coalesceSeconds ?? HOOK_LIMITS.coalesceDefault } };
}

// ── matching and coalescing (sections 4, 5) ──────────────────────────

export interface HookMatchContext {
  /** the agent that owns the hook */
  agentId: string;
  channelIsPrivate: boolean;
  /** current membership of the hook's agent in a private channel */
  agentIsMember: boolean;
}

/** Does this envelope wake this hook? Returns null or the `mentioned` flag. */
export function hookMatches(hook: Pick<HookSpec, 'channels' | 'mentionsOnly' | 'types'>, env: MessageEnvelope<any>, ctx: HookMatchContext): { mentioned: boolean } | null {
  if (env.sender === ctx.agentId) return null; // never wake an agent for its own envelope
  const listed = hook.channels.includes(env.channel);
  const star = hook.channels.includes('*');
  if (ctx.channelIsPrivate) {
    if (!listed || !ctx.agentIsMember) return null; // '*' never expands to private; ex-members get nothing
    if (hook.types && !hook.types.includes(env.type)) return null;
    return { mentioned: false }; // payload is ciphertext to the hub: mentions are not evaluated
  }
  if (!listed && !star) return null;
  if (hook.types && !hook.types.includes(env.type)) return null;
  const mentioned = !env.encrypted && JSON.stringify(env.payload ?? '').includes(ctx.agentId);
  if (hook.mentionsOnly && !mentioned) return null;
  return { mentioned };
}

export interface CoalesceState { lastWakeAt?: Record<string, number> }

/** Decide whether to send now; mutates state when it does. */
export function shouldWake(state: CoalesceState, channel: string, coalesceSeconds: number, now: number): boolean {
  const last = state.lastWakeAt?.[channel];
  if (last !== undefined && now - last < coalesceSeconds * 1000) return false;
  state.lastWakeAt = { ...(state.lastWakeAt ?? {}), [channel]: now };
  return true;
}

export interface WakeBody {
  kind: 'wake' | 'verify';
  hub: string;
  hookId: string;
  agentId: string;
  channel?: string;
  storedSeq?: number;
  envelopeId?: string;
  sender?: string;
  type?: string;
  mentioned?: boolean;
  nonce?: string;
  sentAt: number;
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))));
}

export async function verifyWakeSignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const m = header.match(/^hmac-sha256=([0-9a-f]{64})$/);
  if (!m) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  if (expected.length !== m[1].length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[1].charCodeAt(i);
  return diff === 0;
}
