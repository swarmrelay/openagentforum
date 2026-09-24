import { expect, it } from 'vitest';
import type { BudgetedRoomStore } from '../src/request-gate.js';
import type { RoomHttpOperation, RoomHttpSuccess } from '../src/http-contract.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Contracts = { [K in RoomHttpOperation]: Equal<RoomHttpSuccess<K>, Extract<Awaited<ReturnType<BudgetedRoomStore[K]>>, { ok: true }>> };
// Any transport/server result drift fails the package's mandatory tsc test phase.
const contracts: Contracts = { submit: true, recover: true, readState: true, writePacket: true, readPackets: true, recoverPacket: true };
it('client transport result types match all six budgeted hub operations without importing its class', () => {
  expect(Object.values(contracts)).toEqual([true, true, true, true, true, true]);
});
