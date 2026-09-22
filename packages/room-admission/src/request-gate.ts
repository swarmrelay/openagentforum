/** Internal composition only. Factories bind both budget and protected store to the same database. */
import type { RoomAdmissionStore } from './sqlite.js';
import { ROOM_CONTROL_LIMITS } from './control.js';
import { ROOM_PACKET_LIMITS } from './packet-wire.js';
import { requestBytes, requestTime, type RequestBudget, type RequestCharge, type RequestGateFailure } from './request-budget.js';

type Operations = Pick<RoomAdmissionStore, 'submit' | 'recover' | 'readState' | 'writePacket' | 'readPackets' | 'recoverPacket'>;
type Operation = keyof Operations;
type Result<K extends Operation> = Awaited<ReturnType<Operations[K]>>;

export class BudgetedRoomStore {
  #broken = false;
  #inFlight = 0;
  readonly #store: Operations;
  readonly #budget: RequestBudget;
  readonly #now: () => number;
  readonly #localLimit: number;
  constructor(store: Operations, budget: RequestBudget, now: () => number, localLimit: number) {
    if (!Number.isSafeInteger(localLimit) || localLimit < 1 || localLimit > 64) throw new Error('Invalid local limit');
    this.#store = store; this.#budget = budget; this.#now = now; this.#localLimit = localLimit;
  }
  submit(wire: string, key: string) { return this.#run('submit', wire, key, () => this.#store.submit(wire, key)); }
  recover(wire: string, key: string) { return this.#run('recover', wire, key, () => this.#store.recover(wire, key)); }
  readState(wire: string, key: string) { return this.#run('readState', wire, key, () => this.#store.readState(wire, key)); }
  writePacket(wire: string) { return this.#run('writePacket', wire, undefined, () => this.#store.writePacket(wire)); }
  readPackets(wire: string) { return this.#run('readPackets', wire, undefined, () => this.#store.readPackets(wire)); }
  recoverPacket(wire: string) { return this.#run('recoverPacket', wire, undefined, () => this.#store.recoverPacket(wire)); }

  async #run<K extends Operation>(operation: K, wire: string, key: string | undefined, run: () => Promise<Result<K>>): Promise<Result<K> | RequestGateFailure> {
    if (this.#broken) return { ok: false, reason: 'storage_error' };
    if (this.#inFlight >= this.#localLimit) return { ok: false, reason: 'busy' };
    const bound = operation === 'submit' ? ROOM_CONTROL_LIMITS.wireBytes
      : operation === 'writePacket' ? ROOM_PACKET_LIMITS.wireBytes : ROOM_PACKET_LIMITS.queryBytes;
    if (typeof wire !== 'string' || wire.length > bound || requestBytes(wire) > bound) return { ok: false, reason: 'invalid_wire' };
    if (['submit', 'recover', 'readState'].includes(operation) && (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key))) {
      return { ok: false, reason: 'invalid_public_key' };
    }
    const charge: RequestCharge = { lane: operation === 'recover' || operation === 'recoverPacket' ? 'recovery'
      : operation === 'readState' || operation === 'readPackets' ? 'read' : 'ordinary',
      requests: 1, inputBytes: Math.max(1, requestBytes(wire) + (key?.length ?? 0)),
      verifications: operation === 'readPackets' ? 1 + ROOM_PACKET_LIMITS.readRecords : 1,
      responseBytes: operation === 'readPackets' ? ROOM_PACKET_LIMITS.responseBytes : 4096 };
    if (operation === 'submit') {
      // Untrusted classification ONLY, on a bounded immutable string. The store still
      // checks canonical schema, signatures, full-key authority and current revision.
      try { const candidate: unknown = JSON.parse(wire);
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          && Object.hasOwn(candidate, 'action') && 'action' in candidate && candidate.action === 'close') charge.lane = 'close';
      } catch { /* malformed requests still consume ordinary verification allowance */ }
    }
    this.#inFlight++;
    try {
      const reservation = await this.#budget.reserve(charge);
      if (!reservation.ok) {
        if (reservation.reason === 'storage_error') this.#broken = true;
        return this.#broken ? { ok: false, reason: 'storage_error' } : reservation;
      }
      if (this.#broken) return { ok: false, reason: 'storage_error' };
      // No queued/reusable permits: begin protected work only in the charged window.
      if (requestTime(this.#now()) >= reservation.expiresAt) return { ok: false, reason: 'busy' };
      const result = await run();
      if (!result.ok && result.reason === 'storage_error') this.#broken = true;
      if (this.#broken) return { ok: false, reason: 'storage_error' };
      if (requestBytes(JSON.stringify(result)) > charge.responseBytes) throw new Error('Oversized protected result');
      return result;
    } catch {
      this.#broken = true;
      return { ok: false, reason: 'storage_error' };
    } finally { this.#inFlight--; }
  }
}
