/** Source-only, explicit one-attempt transport. No keys, listeners, signing, retry loop or cipher persistence. */
import { canonicalizeJson, sha256Hex } from '@openagentforum/protocol';
import { recoveryReceipt } from './storage-contract.js';
import { packetReceipt } from './packet-storage-contract.js';
import { verifyHistoricalRoomPacketSignature } from './packet-wire.js';
import { ROOM_HTTP_PATHS, ROOM_HTTP_KEY_HEADER, cancelRoomBody, readRoomBody, roomDeadline, roomWithSignal,
  roomHttpHasKey, roomHttpOrigin, roomHttpRequestBytes, roomHttpResponseBytes,
  type RoomHttpOperation, type RoomHttpSuccess } from './http-contract.js';

const codes = ['invalid_request', 'method_not_allowed', 'origin_not_allowed', 'unsupported_media_type',
  'request_too_large', 'request_timeout', 'room_unavailable', 'room_rate_limited', 'room_request_unavailable', 'room_outcome_unknown'] as const;
type RoomHttpErrorCode = typeof codes[number] | 'room_invalid_response' | 'room_transport_unknown';
export class RoomHttpError extends Error {
  constructor(readonly status: number | null, readonly code: RoomHttpErrorCode, readonly retryAfterSeconds?: number) {
    super(`Room request failed: ${code}`);
  }
  /** No error, including an unavailable response, cancels an earlier uncertain attempt. */
  readonly permitsReplacementMutation = false;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, names: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k));
}
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && !Object.is(value, -0);

async function success<K extends RoomHttpOperation>(operation: K, value: unknown, request: Record<string, unknown>): Promise<RoomHttpSuccess<K>> {
  if (!object(value) || value.ok !== true) throw new Error('Invalid result');
  const write = operation === 'submit' || operation === 'writePacket';
  if (write) {
    if (!exact(value, ['ok', 'replayed', 'receipt']) || typeof value.replayed !== 'boolean') throw new Error('Invalid write result');
  } else if (!exact(value, ['ok', 'queryId', 'observedAt', operation === 'readState' ? 'room' : operation === 'readPackets' ? 'page' : 'receipt'])
    || value.queryId !== request.queryId || !integer(value.observedAt) || !integer(request.expiresAt)
    || Date.now() >= request.expiresAt || value.observedAt >= request.expiresAt) throw new Error('Invalid read result');

  if ('receipt' in value) {
    if (value.receipt === null && !write) return value as RoomHttpSuccess<K>;
    if (!object(value.receipt) || typeof request.hub !== 'string' || typeof request.actor !== 'string'
      || typeof request.roomId !== 'string' || typeof request.requestId !== 'string') throw new Error('Invalid receipt');
    const { signature: _signature, ...unsigned } = request;
    const digest = write ? await sha256Hex(`${request.protocol}\n${canonicalizeJson(unsigned)}`) : request.proofDigest;
    if (typeof digest !== 'string') throw new Error('Invalid receipt context');
    const query = { hub: request.hub, actor: request.actor, roomId: request.roomId, requestId: request.requestId, proofDigest: digest };
    if (operation === 'submit' || operation === 'recover') {
      const receipt = recoveryReceipt(canonicalizeJson(value.receipt), query);
      if (!receipt || (operation === 'submit' && (receipt.action !== request.action || !integer(request.expectedRevision)
        || receipt.revision !== request.expectedRevision + 1))) throw new Error('Uncorrelated control receipt');
    } else {
      if (typeof request.signingPublicKey !== 'string') throw new Error('Invalid key');
      const receipt = packetReceipt(canonicalizeJson(value.receipt), { ...query, signingPublicKey: request.signingPublicKey });
      if (!receipt || (operation === 'writePacket' && (receipt.sessionId !== request.sessionId
        || receipt.packetIndex !== request.packetIndex || receipt.revision !== request.expectedRevision))) throw new Error('Uncorrelated packet receipt');
    }
  } else if (operation === 'readState') {
    if (value.room !== null && (!exact(value.room, ['roomId', 'revision', 'status', 'role'])
      || value.room.roomId !== request.roomId || !integer(value.room.revision, 1)
      || (value.room.status !== 'open' && value.room.status !== 'closed')
      || (value.room.role !== 'owner' && value.room.role !== 'peer'))) throw new Error('Invalid room state');
  } else if (operation === 'readPackets' && value.page !== null) {
    const page = value.page;
    if (!exact(page, ['records', 'nextStoredSeq']) || !Array.isArray(page.records) || !integer(request.limit, 1)
      || request.limit > 8 || page.records.length > request.limit || !integer(request.afterStoredSeq)) throw new Error('Invalid page');
    let cursor = request.afterStoredSeq;
    const seen = new Set<string>();
    for (const row of page.records) {
      if (!exact(row, ['storedSeq', 'wire']) || !integer(row.storedSeq, cursor + 1) || typeof row.wire !== 'string'
        || typeof request.hub !== 'string') throw new Error('Invalid record');
      const verified = await verifyHistoricalRoomPacketSignature(row.wire, request.hub);
      if (!verified.ok || verified.request.roomId !== request.roomId || verified.request.expectedRevision !== request.expectedRevision) throw new Error('Invalid packet binding');
      const identity = `${verified.request.signingPublicKey}:${verified.request.requestId}`;
      if (seen.has(identity)) throw new Error('Duplicate packet');
      seen.add(identity); cursor = row.storedSeq;
    }
    if (page.nextStoredSeq !== (page.records.length ? cursor : null)) throw new Error('Invalid cursor');
    // Signatures authenticate authors, NOT relay cursors, peer selection or content.
    // The session layer must pin both full keys, enforce indexes and deduplicate
    // across pages BEFORE feeding peer bytes into Noise or advancing checkpoints.
  }
  return value as RoomHttpSuccess<K>;
}

export class RoomHttpClient {
  readonly #hub: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  constructor(options: { hub: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.#hub = roomHttpOrigin(options.hub);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeout = options.timeoutMs ?? 20000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 20000) throw new Error('Invalid room HTTP timeout');
  }
  submit(wire: string, key: string) { return this.#call('submit', wire, key); }
  recover(wire: string, key: string) { return this.#call('recover', wire, key); }
  readState(wire: string, key: string) { return this.#call('readState', wire, key); }
  writePacket(wire: string) { return this.#call('writePacket', wire); }
  readPackets(wire: string) { return this.#call('readPackets', wire); }
  recoverPacket(wire: string) { return this.#call('recoverPacket', wire); }

  async #call<K extends RoomHttpOperation>(operation: K, wire: string, key?: string): Promise<RoomHttpSuccess<K>> {
    let request: Record<string, unknown>;
    try {
      if (typeof wire !== 'string' || wire.length > roomHttpRequestBytes(operation) || new TextEncoder().encode(wire).byteLength > roomHttpRequestBytes(operation)
        || (roomHttpHasKey(operation) && (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)))) throw new Error('Invalid request');
      const parsed: unknown = JSON.parse(wire);
      if (!object(parsed) || parsed.hub !== this.#hub) throw new Error('Invalid request context');
      request = parsed;
    } catch { throw new RoomHttpError(null, 'invalid_request'); }
    const deadline = roomDeadline(this.#timeout);
    let response: Response | undefined;
    try {
      response = await roomWithSignal<Response>(this.#fetch(`${this.#hub}${ROOM_HTTP_PATHS[operation]}`, {
        method: 'POST', body: wire, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: deadline.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(key ? { [ROOM_HTTP_KEY_HEADER]: key } : {}) },
      }).then(result => { if (deadline.signal.aborted) cancelRoomBody(result.body); return result; }), deadline.signal);
      if (response.redirected || (response.url && response.url !== `${this.#hub}${ROOM_HTTP_PATHS[operation]}`)
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) throw new Error('Invalid response');
      const raw = await readRoomBody(response.body, response.status === 200 ? roomHttpResponseBytes(operation) : 4096, deadline.signal);
      let result: unknown;
      try { result = JSON.parse(raw); } catch { throw new Error('Invalid response'); }
      if (response.status !== 200) {
        if (!exact(result, ['ok', 'error']) || result.ok !== false || !codes.some(code => code === result.error)) throw new Error('Invalid error');
        const retry = response.headers.get('retry-after');
        const retryAfter = retry !== null && /^[1-9][0-9]{0,4}$/.test(retry) && Number(retry) <= 86400 ? Number(retry) : undefined;
        throw new RoomHttpError(response.status, result.error as typeof codes[number], retryAfter);
      }
      try {
        const validated = await roomWithSignal(success(operation, result, request), deadline.signal);
        if (!['submit', 'writePacket'].includes(operation) && (!integer(request.expiresAt) || Date.now() >= request.expiresAt)) throw new Error('Expired response');
        return validated;
      } catch { throw new RoomHttpError(response.status, 'room_invalid_response'); }
    } catch (failure) {
      if (failure instanceof RoomHttpError) throw failure;
      throw new RoomHttpError(response?.status ?? null, 'room_transport_unknown');
    } finally { deadline.close(); if (response) cancelRoomBody(response.body); }
  }
}
