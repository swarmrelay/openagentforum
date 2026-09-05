import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request, type RequestOptions } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { classifyAddress, hmacSha256Hex, validateHookUrl } from '@openagentforum/protocol';
import type { DeliveryJob, DeliveryResult } from './job.js';

const CONNECT_MS = 3000;
const TOTAL_MS = 5000;
const MAX_RESPONSE_BYTES = 1024;

export type ResolveAddresses = (host: string, signal: AbortSignal) => Promise<string[]>;

/** Query both families, not getaddrinfo's potentially filtered view. Fail closed on partial errors. */
export const resolveAddresses: ResolveAddresses = async (host, signal) => {
  const resolver = new Resolver({ timeout: CONNECT_MS, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  const optionalFamily = async (query: Promise<string[]>) => {
    try { return await query; }
    catch (error) {
      // ENODATA means this name has no records of that family. SERVFAIL, timeout,
      // and even inconsistent NXDOMAIN for one family are not evidence of safety.
      if ((error as NodeJS.ErrnoException).code === 'ENODATA') return [];
      throw error;
    }
  };
  try {
    const [v4, v6] = await Promise.all([optionalFamily(resolver.resolve4(host)), optionalFamily(resolver.resolve6(host))]);
    signal.throwIfAborted();
    return [...new Set([...v4, ...v6])];
  } finally {
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
};

function failure(code: DeliveryResult['code'], retryable = false, status?: number): DeliveryResult {
  return { ok: false, code, retryable, ...(status === undefined ? {} : { status }) };
}

function networkFailure(error: unknown): DeliveryResult {
  const code = (error as NodeJS.ErrnoException)?.code ?? '';
  return /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)
    ? failure('tls_error') : failure('network_error', true);
}

/** Direct IP dialing; the original hostname is retained only for Host, SNI and certificate checks. */
export function pinnedOptions(url: URL, address: string, signature: string, hookId: string, bytes: number): RequestOptions {
  return {
    protocol: 'https:', hostname: address, family: isIP(address), port: 443,
    servername: url.hostname, rejectUnauthorized: true,
    checkServerIdentity: (_host, cert) => checkServerIdentity(url.hostname, cert),
    method: 'POST', path: url.pathname + url.search,
    agent: false, // no pooled connections, proxy agents, or TLS session reuse
    maxHeaderSize: 8192,
    headers: {
      Host: url.hostname, 'Content-Type': 'application/json', 'Content-Length': bytes,
      'User-Agent': 'SwarmRelay-Hub/1.0', 'X-OAF-Hook': hookId,
      'X-OAF-Signature': `hmac-sha256=${signature}`, Connection: 'close',
    },
  };
}

/** One attempt only. The hub owns verification state, durable scheduling, and deliberate retries. */
export async function deliver(job: DeliveryJob): Promise<DeliveryResult> {
  return deliverWith(job, resolveAddresses, request);
}

/** Dependency seam for offline adversarial DNS/socket tests; never configurable over HTTP/env. */
export async function deliverWith(job: DeliveryJob, resolve: ResolveAddresses, send: typeof request): Promise<DeliveryResult> {
  const checked = validateHookUrl(job.url);
  if (!checked.ok) return failure('unsafe_url');
  const controller = new AbortController();
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_MS);
  const connectTimer = setTimeout(() => controller.abort(), CONNECT_MS);
  try {
    let addresses: string[];
    try { addresses = await resolve(checked.host, controller.signal); }
    catch { return failure(controller.signal.aborted ? 'timeout' : 'dns_failed', true); }
    if (controller.signal.aborted) return failure('timeout', true);
    if (!addresses.length) return failure('dns_failed', true);
    if (addresses.some(address => !isIP(address) || classifyAddress(address) !== 'public')) return failure('unsafe_address');
    const rawBody = JSON.stringify(job.body);
    const signature = await hmacSha256Hex(job.secret, rawBody);
    if (controller.signal.aborted) return failure('timeout', true);
    return await new Promise<DeliveryResult>((resolveResult) => {
      let finished = false;
      const finish = (result: DeliveryResult) => {
        if (finished) return;
        finished = true;
        resolveResult(result);
      };
      const req = send({ ...pinnedOptions(checked.url, addresses[0], signature, job.body.hookId, Buffer.byteLength(rawBody)), signal: controller.signal }, res => {
        const status = res.statusCode ?? 0;
        res.on('error', error => finish(controller.signal.aborted ? failure('timeout', true) : networkFailure(error)));
        res.on('aborted', () => finish(failure('network_error', true)));
        if (status < 200 || status >= 300) {
          finish(failure('http_error', status >= 500 && status <= 599, status));
          res.destroy(); // especially 3xx: never follow Location
          return;
        }
        if (job.body.kind === 'verify' && status !== 200) {
          finish(failure('invalid_verification', false, status));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            finish(failure('response_too_large', false, status));
            res.destroy();
          } else if (job.body.kind === 'verify') chunks.push(chunk);
        });
        res.on('end', () => {
          if (job.body.kind === 'wake') return finish({ ok: true, code: 'delivered', retryable: false, status });
          try {
            const echo: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (echo && typeof echo === 'object' && !Array.isArray(echo) &&
                'nonce' in echo && echo.nonce === job.body.nonce && 'hookId' in echo && echo.hookId === job.body.hookId) {
              return finish({ ok: true, code: 'verified', retryable: false, status });
            }
          } catch { /* all malformed echoes have the same sanitized result */ }
          finish(failure('invalid_verification', false, status));
        });
      });
      req.on('socket', socket => socket.once('secureConnect', () => clearTimeout(connectTimer)));
      req.on('error', error => finish(controller.signal.aborted ? failure('timeout', true) : networkFailure(error)));
      req.end(rawBody);
    });
  } catch (error) {
    return controller.signal.aborted ? failure('timeout', true) : networkFailure(error);
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(connectTimer);
  }
}
