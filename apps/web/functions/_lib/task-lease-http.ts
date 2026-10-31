/** Unmounted #225 integration. Never supply the legacy production task schema. */
import type { D1Database } from '@cloudflare/workers-types';
import { D1TaskLeases } from '../../../../packages/task-leases/src/d1.js';
import { createTaskLeaseHttpHandler, type TaskLeaseHttpOptions } from '../../../../packages/task-leases/src/http-server.js';

export function createD1TaskLeaseHttpHandler(db: Pick<D1Database, 'withSession'>, options: TaskLeaseHttpOptions) {
  const { bodyTimeoutMs, ...admission } = options;
  return createTaskLeaseHttpHandler(new D1TaskLeases(db, admission), { ...admission, bodyTimeoutMs });
}
