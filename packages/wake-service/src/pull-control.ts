import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { checkServerIdentity } from 'node:tls';
import { validateHookUrl } from '@openagentforum/protocol';
import { MAX_JOB_BYTES, parseJob, type DeliveryJob, type DeliveryResult } from './job.js';
import { cleanResult, exact, isCursor, isRef, object, sameRef, type PollReply, type PullCursor, type WorkRef } from './pull-protocol.js';

export const CONTROL_TIMEOUT_MS = 3000;
export interface PullControl {
  poll(after: PullCursor | null, signal: AbortSignal): Promise<PollReply>;
  authorize(ref: WorkRef, signal: AbortSignal): Promise<DeliveryJob | null>;
  complete(ref: WorkRef, result: DeliveryResult, signal: AbortSignal): Promise<void>;
}
export class ControlError extends Error {
  constructor(readonly code: 'unavailable' | 'rejected' | 'invalid_response' | 'aborted' | 'timeout') { super(code); }
}
export type ControlRequest = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

/** Operator-configured destination only. This is NOT the callback transport. */
export function createPullControl(options: {
  endpoint: string; hub: string; token: string;
  /** Offline test seam; no CLI/environment override. */
  request?: ControlRequest;
}): PullControl {
  const checked = validateHookUrl(options.endpoint);
  const hub = new URL(options.hub);
  if (!checked.ok || checked.url.href !== options.endpoint || checked.url.pathname !== '/internal/wake-control' ||
      checked.url.search || checked.url.hash || hub.protocol !== 'https:' || hub.origin !== options.hub ||
      !/^[a-f0-9]{64}$/.test(options.token)) throw new Error('invalid pull control configuration');
  const endpoint = checked.url;
  const token = options.token;
  const send = options.request ?? request;
  const post = (body: object, limit: number, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let finished = false;
    const finish = (error: ControlError | null, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      // Destroy even rejected/oversize/late streams; never follow a Location header.
      response?.destroy();
      req?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new ControlError('aborted'));
    const timer = setTimeout(() => finish(new ControlError('timeout')), CONTROL_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    try {
      const raw = JSON.stringify(body);
      if (Buffer.byteLength(raw) > 2048) return finish(new ControlError('rejected'));
      req = send({
        protocol: 'https:', hostname: endpoint.hostname, port: 443, servername: endpoint.hostname,
        rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(endpoint.hostname, cert),
        method: 'POST', path: endpoint.pathname, agent: false, maxHeaderSize: 8192,
        headers: { Host: endpoint.hostname, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          Accept: 'application/json', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(raw), Connection: 'close' },
      }, res => {
        res.on('error', () => finish(new ControlError('unavailable')));
        if (finished) { res.destroy(); return; }
        response = res;
        if (res.statusCode !== 200) return finish(new ControlError('rejected'));
        const length = res.headers['content-length'];
        if (res.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
            res.headers['content-encoding'] !== undefined ||
            (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit))) return finish(new ControlError('invalid_response'));
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('aborted', () => finish(new ControlError('unavailable')));
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit) return finish(new ControlError('invalid_response'));
          chunks.push(chunk);
        });
        res.on('end', () => {
          try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
          catch { finish(new ControlError('invalid_response')); }
        });
      });
      req.on('error', () => finish(new ControlError('unavailable')));
      if (finished) req.destroy(); else req.end(raw);
    } catch { finish(new ControlError('unavailable')); }
  });
  return {
    async poll(after, signal) {
      if (!isCursor(after)) throw new ControlError('rejected');
      const reply = await post({ op: 'poll', after }, 1024, signal);
      if (!object(reply) || !exact(reply, ['ref', 'after']) || !isCursor(reply.after) ||
          (reply.ref !== null && !isRef(reply.ref))) throw new ControlError('invalid_response');
      return { ref: reply.ref, after: reply.after };
    },
    async authorize(ref, signal) {
      if (!isRef(ref)) throw new ControlError('rejected');
      const reply = await post({ op: 'authorize', ref }, MAX_JOB_BYTES + 64, signal);
      if (!object(reply) || !exact(reply, ['job'])) throw new ControlError('invalid_response');
      if (reply.job === null) return null;
      if (Buffer.byteLength(JSON.stringify(reply.job)) > MAX_JOB_BYTES) throw new ControlError('invalid_response');
      const job = await parseJob(reply.job, options.hub, Date.now());
      if (signal.aborted) throw new ControlError('aborted');
      if (!job || !sameRef(ref, { jobId: job.jobId, agentId: job.body.agentId, kind: job.body.kind })) throw new ControlError('invalid_response');
      return job;
    },
    async complete(ref, result, signal) {
      if (!isRef(ref)) throw new ControlError('rejected');
      const sanitized = cleanResult(result, ref.kind);
      if (!sanitized) throw new ControlError('rejected');
      const reply = await post({ op: 'complete', ref, result: sanitized }, 1024, signal);
      if (!object(reply) || !exact(reply, ['ack']) || !isRef(reply.ack) || !sameRef(reply.ack, ref)) throw new ControlError('invalid_response');
    },
  };
}
