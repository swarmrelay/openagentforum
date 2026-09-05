import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseJob, MAX_JOB_BYTES, type DeliveryJob, type DeliveryResult } from './job.js';
import { AttemptLedger } from './ledger.js';
import { deliver } from './transport.js';

class IngressError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => fail(new IngressError(408, 'body_timeout')), 2000);
    function cleanup() {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAbort);
      req.off('error', onAbort);
    }
    function fail(error: IngressError) { cleanup(); req.pause(); reject(error); }
    function onData(chunk: Buffer) {
      bytes += chunk.length;
      if (bytes > MAX_JOB_BYTES) return fail(new IngressError(413, 'body_too_large'));
      chunks.push(chunk);
    }
    function onEnd() {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new IngressError(400, 'invalid_json')); }
    }
    function onAbort() { fail(new IngressError(400, 'incomplete_body')); }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAbort);
    req.on('error', onAbort);
  });
}

function respond(res: ServerResponse, status: number, body: object, retryAfter?: number) {
  res.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close',
    ...(retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) }),
  });
  res.end(JSON.stringify(body));
}

export interface ServiceOptions {
  token: string;
  hub: string;
  ledger: AttemptLedger;
  maxConcurrent?: number;
  /** Test seam; production always uses the pinned transport. */
  deliver?: (job: DeliveryJob) => Promise<DeliveryResult>;
}

/** Internal bearer-authenticated egress, not an agent-facing arbitrary HTTP proxy. */
export function createWakeService(options: ServiceOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error('token must be 32 random bytes encoded as lowercase hex');
  const origin = new URL(options.hub);
  if (origin.protocol !== 'https:' || origin.origin !== options.hub || origin.username || origin.password) throw new Error('hub must be an HTTPS origin without a trailing slash');
  const expectedToken = createHash('sha256').update(`Bearer ${options.token}`).digest();
  const maxConcurrent = options.maxConcurrent ?? 16;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) throw new Error('invalid concurrency');
  let active = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // No credentials, callback addresses, nonces, or raw errors are logged by this process.
    if (req.method === 'GET' && req.url === '/healthz') return respond(res, 200, { ok: true, role: 'wake-egress', publicHooks: false });
    const authorization = req.headers.authorization ?? '';
    if (!timingSafeEqual(createHash('sha256').update(authorization).digest(), expectedToken)) return respond(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST' || req.url !== '/internal/deliver') return respond(res, 404, { error: 'not_found' });
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' || req.headers['content-encoding']) return respond(res, 415, { error: 'json_required' });
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_JOB_BYTES)) return respond(res, 413, { error: 'body_too_large' });
    if (active >= maxConcurrent) return respond(res, 503, { error: 'busy' }, 1);
    active++;
    try {
      const job = await parseJob(await readBody(req), options.hub, Date.now());
      if (!job) return respond(res, 400, { error: 'invalid_job' });
      const reservation = options.ledger.reserve(job, Date.now());
      if (reservation.kind === 'conflict') return respond(res, 409, { error: 'job_id_conflict' });
      if (reservation.kind === 'limited') return respond(res, 429, { error: 'attempt_limit' }, reservation.retryAfter);
      if (reservation.kind === 'duplicate') return respond(res, 200, { duplicate: true, result: reservation.result });
      const result = await (options.deliver ?? deliver)(job);
      options.ledger.complete(job.jobId, result);
      return respond(res, 200, { duplicate: false, result });
    } finally { active--; }
  };
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10_000 }, (req, res) => {
    // A peer may reset after readBody has removed its temporary error listener.
    // Keep the stream error handled without logging request content.
    req.on('error', () => {});
    res.on('error', () => {});
    void handle(req, res).catch(error => {
      if (!res.headersSent && !res.destroyed) respond(res, error instanceof IngressError ? error.status : 503, { error: error instanceof IngressError ? error.code : 'unavailable' });
    });
  });
  server.maxConnections = maxConcurrent * 4;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(10_000, socket => socket.destroy());
  server.on('checkContinue', (_req, res) => respond(res, 417, { error: 'expect_not_supported' }));
  return server;
}
