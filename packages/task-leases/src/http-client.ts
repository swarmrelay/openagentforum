/** Explicit transport: no signing, automatic retry, discovery or key custody. */
import { LIMITS, PROFILE, hex, integer, object, verifyWire, type Proof, type Receipt, type Result } from './contract.js';
import { RESPONSE_BYTES, HTTP_ERRORS, cancelBody, deadline, fields, path, proofRoute, readBody, sameScope, scope,
  withSignal, type HttpCode, type Scope } from './http-contract.js';

export class TaskLeaseHttpError extends Error {
  readonly permitsReplacementMutation = false;
  constructor(readonly status: number | null, readonly code: HttpCode | 'task_invalid_response' | 'task_transport_unknown' | 'task_client_busy',
    readonly retryAfterSeconds?: number) { super(`Task lease request failed: ${code}`); }
}
export interface TaskLeaseHttpClientOptions extends Scope { actorKey: string; fetch?: typeof fetch; timeoutMs?: number }
export function receiptMatches(value: unknown, proof: Proof): value is Receipt {
  const c = proof.command;
  if (c.action === 'receipt' || !fields(value, ['profile', 'audience', 'taskId', 'actorKey', 'operationId', 'commandDigest',
    'action', 'revision', 'generation', 'status', 'committedAt', 'leaseExpiresAt', 'resultDigest', 'resolutionDigest'])
    || value.profile !== PROFILE || value.audience !== c.audience || value.taskId !== proof.taskId || value.actorKey !== c.actorKey
    || value.operationId !== c.operationId || value.commandDigest !== proof.digest || value.action !== c.action
    || value.revision !== (c.action === 'create' ? 0 : c.expectedRevision! + 1) || !integer(value.generation)
    || !integer(value.committedAt) || value.committedAt < Math.max(0, c.issuedAt - LIMITS.futureSkewMs)
    || value.committedAt >= c.expiresAt || value.resultDigest !== proof.resultDigest
    || value.resolutionDigest !== (c.action === 'reopen' ? c.payload.resolutionDigest : null)) return false;
  if (c.action === 'create') return value.status === 'open' && value.generation === 0 && value.leaseExpiresAt === null;
  if (c.action === 'claim') return value.status === 'claimed' && value.generation > 0
    && integer(value.leaseExpiresAt) && value.leaseExpiresAt - value.committedAt >= LIMITS.minLeaseMs
    && value.leaseExpiresAt - value.committedAt <= LIMITS.maxLeaseMs;
  if (value.generation !== c.payload.generation) return false;
  if (c.action === 'submit') return value.status === 'completed' && integer(value.leaseExpiresAt) && value.leaseExpiresAt > value.committedAt;
  if (c.action === 'reopen') return value.status === 'open' && value.leaseExpiresAt === null;
  return value.status === 'open' && value.leaseExpiresAt === null
    || value.status === 'reconciliation' && integer(value.leaseExpiresAt);
}

export class TaskLeaseHttpClient {
  readonly #scope: Scope;
  readonly #actor: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  #busy = false;
  constructor(options: TaskLeaseHttpClientOptions) {
    this.#scope = scope(options); this.#actor = options.actorKey;
    this.#timeout = options.timeoutMs ?? 10000;
    if (!hex(this.#actor, 64) || !Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 10000) {
      throw new Error('Invalid task lease client configuration');
    }
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  async #proof(wire: string) {
    try {
      const proof = await verifyWire(wire);
      if (proof.command.actorKey !== this.#actor || proof.command.audience !== this.#scope.audience) throw new Error();
      return proof;
    } catch { throw new TaskLeaseHttpError(null, 'invalid_request'); }
  }
  /** For a trusted journal; validation does not contact the hub or establish authority. */
  async describe(wire: string) {
    const proof = await this.#proof(wire);
    if (proof.command.action === 'receipt') throw new TaskLeaseHttpError(null, 'invalid_request');
    return { ...this.#scope, actorKey: this.#actor, operationId: proof.command.operationId, taskId: proof.taskId,
      commandDigest: proof.digest, wire };
  }
  async write(wire: string): Promise<Result> { return this.#call(wire); }
  /** Both inputs are explicit: the retained original and a separately signed fresh query. */
  async recover(originalWire: string, queryWire: string): Promise<Result> { return this.#call(originalWire, queryWire); }
  async #call(originalWire: string, queryWire?: string): Promise<Result> {
    if (this.#busy) throw new TaskLeaseHttpError(null, 'task_client_busy');
    this.#busy = true;
    try {
      const original = await this.#proof(originalWire);
      if (original.command.action === 'receipt') throw new TaskLeaseHttpError(null, 'invalid_request');
      const query = queryWire === undefined ? original : await this.#proof(queryWire);
      if (queryWire !== undefined && (query.command.action !== 'receipt' || query.taskId !== original.taskId
        || query.command.payload.operationId !== original.command.operationId || query.command.payload.commandDigest !== original.digest)) {
        throw new TaskLeaseHttpError(null, 'invalid_request');
      }
      const target = this.#scope.origin + path(proofRoute(query)), time = deadline(this.#timeout);
      let response: Response | undefined;
      try {
        response = await withSignal<Response>(this.#fetch(target, { method: 'POST', body: queryWire ?? originalWire,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          redirect: 'error', credentials: 'omit', cache: 'no-store', signal: time.signal,
        }).then(result => { if (time.signal.aborted) cancelBody(result.body); return result; }), time.signal);
        time.check();
        if (response.redirected || response.url && response.url !== target
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) {
          throw new TaskLeaseHttpError(response.status, 'task_invalid_response');
        }
        const raw = await readBody(response.body, RESPONSE_BYTES, time.signal);
        let value: unknown;
        try { value = JSON.parse(raw); } catch { throw new TaskLeaseHttpError(response.status, 'task_invalid_response'); }
        if (response.status !== 200) {
          if (!fields(value, ['ok', 'error']) || value.ok !== false || !HTTP_ERRORS.some(code => code === value.error)) {
            throw new TaskLeaseHttpError(response.status, 'task_invalid_response');
          }
          const hint = response.headers.get('retry-after');
          const retry = response.status === 429 && hint !== null && /^[1-9][0-9]{0,4}$/.test(hint) && Number(hint) <= 86400
            ? Number(hint) : undefined;
          throw new TaskLeaseHttpError(response.status, value.error as HttpCode, retry);
        }
        if (queryWire !== undefined && fields(value, ['ok', 'scope', 'outcome', 'historical']) && value.ok === true
          && sameScope(value.scope, this.#scope) && value.outcome === 'unavailable' && value.historical === true) {
          time.check(); return { outcome: 'unavailable', historical: true };
        }
        const names = ['ok', 'scope', 'outcome', 'receipt', 'historical'];
        if (object(value) && Object.hasOwn(value, 'replayed')) names.push('replayed');
        if (!fields(value, names) || value.ok !== true || !sameScope(value.scope, this.#scope)
          || value.outcome !== 'found' || value.historical !== true || !receiptMatches(value.receipt, original)
          || Object.hasOwn(value, 'replayed') && (queryWire !== undefined || typeof value.replayed !== 'boolean')) {
          throw new TaskLeaseHttpError(response.status, 'task_invalid_response');
        }
        time.check(); return { outcome: 'found', historical: true, receipt: value.receipt,
          ...(typeof value.replayed === 'boolean' ? { replayed: value.replayed } : {}) };
      } catch (failure) {
        if (failure instanceof TaskLeaseHttpError) throw failure;
        throw new TaskLeaseHttpError(response?.status ?? null, 'task_transport_unknown');
      } finally { time.close(); if (response) cancelBody(response.body); }
    } finally { this.#busy = false; }
  }
}

export type PendingTaskLeaseOperation = Awaited<ReturnType<TaskLeaseHttpClient['describe']>>;
/** Resolving retain/acknowledge is a trusted durability promise. Preserve exact
 * wires and pending operations across restart; never evict or infer absence. */
export interface TaskLeaseOperationJournal {
  retain(operation: PendingTaskLeaseOperation): Promise<void>;
  acknowledge(operation: PendingTaskLeaseOperation, receipt: Receipt): Promise<void>;
}
export class JournaledTaskLeaseClient {
  #busy = false;
  constructor(readonly transport: TaskLeaseHttpClient, readonly journal: TaskLeaseOperationJournal) {}
  async #run(wire: string, queryWire?: string) {
    if (this.#busy) throw new TaskLeaseHttpError(null, 'task_client_busy');
    this.#busy = true;
    try {
      const operation = await this.transport.describe(wire);
      await this.journal.retain(operation);
      const result = queryWire === undefined ? await this.transport.write(wire) : await this.transport.recover(wire, queryWire);
      if (result.outcome === 'found') await this.journal.acknowledge(operation, result.receipt);
      return result;
    } finally { this.#busy = false; }
  }
  async write(wire: string) { return this.#run(wire); }
  async recover(originalWire: string, queryWire: string) { return this.#run(originalWire, queryWire); }
}
