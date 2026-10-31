/** Explicit one-POST transport. No signing, automatic retry, key custody or listeners. */
import { deriveAgentId, verifyEnvelope } from '@openagentforum/protocol';
import { hex, safe, parseWire, type Receipt, type ReceiptResult } from './contract.js';
import { HTTP_WIRE_BYTES, HTTP_RESPONSE_BYTES, POLL_HTTP_ERRORS, cancelPollBody, pollDeadline, pollWithSignal,
  readPollBody, pollHttpOrigin, pollHttpPath, type PollHttpRoute, type PollHttpErrorCode } from './http-contract.js';

export class PollHttpError extends Error {
  constructor(readonly status: number | null,
    readonly code: PollHttpErrorCode | 'poll_invalid_response' | 'poll_transport_unknown', readonly retryAfterSeconds?: number) {
    super(`Poll request failed: ${code}`);
  }
  readonly permitsReplacementMutation = false;
}
export interface PollHttpClientOptions {
  origin: string; generation: string; policyRevision: string; actorKey: string;
  fetch?: typeof fetch; timeoutMs?: number;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const fields = (v: unknown, names: string[]): v is Record<string, unknown> => object(v)
  && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
export function pollReceiptMatches(value: unknown, env: ReturnType<typeof parseWire>, config: PollHttpClientOptions): value is Receipt {
  return fields(value, ['origin', 'generation', 'policyRevision', 'id', 'channel', 'actorKey', 'signature', 'checksum',
    'storedSeq', 'pollRevision', 'committedAt', 'historical'])
    && value.origin === config.origin && value.generation === config.generation && value.policyRevision === config.policyRevision
    && value.id === env.id && value.channel === env.channel && value.actorKey === config.actorKey
    && value.signature === env.signature && value.checksum === env.checksum && value.historical === true
    && safe(value.storedSeq) && value.storedSeq > 0 && safe(value.committedAt)
    && (env.type === 'intel' ? value.pollRevision === null : safe(value.pollRevision) && value.pollRevision > 0);
}

export class PollHttpClient {
  readonly #config: PollHttpClientOptions;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  constructor(options: PollHttpClientOptions) {
    this.#config = { origin: pollHttpOrigin(options.origin), generation: options.generation,
      policyRevision: options.policyRevision, actorKey: options.actorKey };
    if (!hex(options.actorKey, 64) || options.actorKey !== options.actorKey.toLowerCase()
      || !hex(options.generation, 64) || options.generation !== options.generation.toLowerCase()
      || typeof options.policyRevision !== 'string' || !options.policyRevision.length || options.policyRevision.length > 128
      || /[^a-zA-Z0-9_.:-]/.test(options.policyRevision)) throw new Error('Invalid poll client configuration');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeout = options.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 10000) throw new Error('Invalid poll client timeout');
  }
  /** Validation is also exposed to a trusted durable journal, before it retains data. */
  async describe(wire: string) {
    const config = this.#config;
    let env: ReturnType<typeof parseWire>;
    try {
      env = parseWire(wire, { wireBytes: HTTP_WIRE_BYTES });
      const id = await deriveAgentId(config.actorKey);
      if (env.sender !== id || !(await verifyEnvelope(env, config.actorKey)).valid) throw new Error('Invalid actor');
    } catch { throw new PollHttpError(null, 'invalid_request'); }
    const route: PollHttpRoute = env.type === 'poll' && env.payload?.kind === 'close'
      ? { operation: 'close', channel: env.channel, pollId: env.payload.pollId } : { operation: 'write', channel: env.channel };
    try { pollHttpPath(route); } catch { throw new PollHttpError(null, 'invalid_request'); }
    return { origin: config.origin, generation: config.generation, policyRevision: config.policyRevision,
      actorKey: config.actorKey, id: env.id, wire, route };
  }
  async write(wire: string): Promise<ReceiptResult> { return this.#call(wire, false); }
  async recover(wire: string): Promise<ReceiptResult> { return this.#call(wire, true); }
  async #call(wire: string, recovery: boolean): Promise<ReceiptResult> {
    const description = await this.describe(wire);
    const route: PollHttpRoute = recovery ? { operation: 'recover', channel: description.route.channel } : description.route;
    const target = this.#config.origin + pollHttpPath(route), deadline = pollDeadline(this.#timeout);
    let response: Response | undefined;
    try {
      response = await pollWithSignal<Response>(this.#fetch(target, { method: 'POST', body: wire,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        signal: deadline.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      }).then(result => { if (deadline.signal.aborted) cancelPollBody(result.body); return result; }), deadline.signal);
      deadline.check();
      if (response.redirected || (response.url && response.url !== target)
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) {
        throw new PollHttpError(response.status, 'poll_invalid_response');
      }
      const raw = await readPollBody(response.body, HTTP_RESPONSE_BYTES, deadline.signal);
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new PollHttpError(response.status, 'poll_invalid_response'); }
      if (response.status !== 200) {
        if (!fields(value, ['ok', 'error']) || value.ok !== false || !POLL_HTTP_ERRORS.some(code => code === value.error)) {
          throw new PollHttpError(response.status, 'poll_invalid_response');
        }
        const hint = response.headers.get('retry-after');
        const retry = hint !== null && /^[1-9][0-9]{0,4}$/.test(hint) && Number(hint) <= 86400 ? Number(hint) : undefined;
        throw new PollHttpError(response.status, value.error as PollHttpErrorCode, retry);
      }
      if (fields(value, ['ok', 'outcome', 'historical']) && value.ok === true
        && value.outcome === 'unavailable' && value.historical === true) {
        deadline.check(); return { outcome: 'unavailable', historical: true };
      }
      const names = ['ok', 'outcome', 'receipt', 'historical'];
      if (object(value) && Object.hasOwn(value, 'replayed')) names.push('replayed');
      const env = parseWire(wire, { wireBytes: HTTP_WIRE_BYTES });
      if (!fields(value, names) || value.ok !== true || value.outcome !== 'found' || value.historical !== true
        || (Object.hasOwn(value, 'replayed') && (recovery || value.replayed !== false))
        || !pollReceiptMatches(value.receipt, env, this.#config)) throw new PollHttpError(response.status, 'poll_invalid_response');
      deadline.check();
      return { outcome: 'found', historical: true, receipt: value.receipt,
        ...(value.replayed === false ? { replayed: false } : {}) };
    } catch (failure) {
      if (failure instanceof PollHttpError) throw failure;
      throw new PollHttpError(response?.status ?? null, 'poll_transport_unknown');
    } finally { deadline.close(); if (response) cancelPollBody(response.body); }
  }
}

export type PendingPollOperation = Awaited<ReturnType<PollHttpClient['describe']>>;
/** Implementations must durably retain exact bytes before resolving; no eviction,
 * automatic retry, or absence inference. A failed ACK write leaves the operation pending. */
export interface PollOperationJournal {
  retain(operation: PendingPollOperation): Promise<void>;
  acknowledge(operation: PendingPollOperation, receipt: Receipt): Promise<void>;
}
export class JournaledPollClient {
  constructor(readonly transport: PollHttpClient, readonly journal: PollOperationJournal) {}
  async write(wire: string) {
    const operation = await this.transport.describe(wire);
    await this.journal.retain(operation);
    const result = await this.transport.write(wire);
    if (result.outcome === 'found') await this.journal.acknowledge(operation, result.receipt);
    return result;
  }
  async recover(wire: string) {
    const operation = await this.transport.describe(wire);
    await this.journal.retain(operation);
    const result = await this.transport.recover(wire);
    if (result.outcome === 'found') await this.journal.acknowledge(operation, result.receipt);
    return result;
  }
}
