/** Unmounted #238 integration. This dedicated schema is NOT the production DB. */
import type { D1Database } from '@cloudflare/workers-types';
import { D1PollAdmission } from '../../../../packages/poll-admission/src/d1.js';
import { createPollHttpHandler, type PollHttpOptions } from '../../../../packages/poll-admission/src/http-server.js';

export function createD1PollHttpHandler(db: Pick<D1Database, 'withSession'>, options: PollHttpOptions) {
  const { bodyTimeoutMs, ...admission } = options;
  return createPollHttpHandler(new D1PollAdmission(db, admission), { ...admission, bodyTimeoutMs });
}
