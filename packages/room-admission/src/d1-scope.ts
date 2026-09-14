/** Caller-lifetime local verification bound, NOT a durable/global abuse policy. */
export class D1RoomOperationScope {
  #inFlight = 0;
  #broken = false;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid operation limit');
  }
  get broken() { return this.#broken; }
  enter(): 'busy' | 'storage_error' | null {
    if (this.#broken) return 'storage_error';
    if (this.#inFlight >= this.limit) return 'busy';
    this.#inFlight++;
    return null;
  }
  leave() { this.#inFlight--; }
  poison() { this.#broken = true; }
}
