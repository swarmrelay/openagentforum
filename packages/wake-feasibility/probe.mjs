// LOCAL TEST PROBE, not a sender. No caller-supplied URLs, jobs or credentials.
// Every fetch is intercepted by the harness; raw TCP is deliberately not opened.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { request } from 'node:https';
import { deliverWith, pinnedOptions } from '../wake-service/src/transport.ts';

const receiver = new URL('https://receiver.example.invalid/wake');

async function requestProbe(extra) {
  return new Promise(resolve => {
    let req;
    let socketEvents = 0;
    let identityChecks = 0;
    const finish = value => resolve({ ...value, socketEvents, identityChecks });
    try {
      req = request({
        hostname: '192.0.2.1', port: 443, method: 'POST', path: '/wake',
        headers: { Host: receiver.hostname },
        ...extra(() => { identityChecks++; return new Error('test-only identity rejection'); }),
        signal: AbortSignal.timeout(2000),
      }, res => {
        const status = res.statusCode;
        res.on('error', () => finish({ kind: 'network_error' }));
        res.on('end', () => finish({ kind: 'response', status }));
        res.resume(); // Harness response is empty; no uncontrolled body is read.
      });
      req.on('socket', () => { socketEvents++; });
      req.on('error', error => finish({ kind: 'error', code: error.code ?? 'unknown' }));
      req.end();
    } catch (error) {
      req?.destroy();
      finish({ kind: 'error', code: error.code ?? 'unknown' });
    }
  });
}

export default class Probe extends WorkerEntrypoint {
  fetch() { return new Response(null, { status: 404 }); }

  async inspect(name) {
    switch (name) {
      case 'production-options':
        return requestProbe(() => pinnedOptions(receiver, '192.0.2.1', '0'.repeat(64), 'hook_0123456789abcdef', 0));
      case 'custom-lookup':
        return requestProbe(() => ({ lookup() { throw new Error('must not run'); } }));
      case 'custom-connection':
        return requestProbe(() => ({ createConnection() { throw new Error('must not run'); } }));
      case 'tls-options-without-header-cap':
        // Intentionally incomplete candidate: demonstrates why removing rejected
        // options to make a port "work" is NOT a safe production fix.
        return requestProbe(checkServerIdentity => ({
          servername: receiver.hostname, rejectUnauthorized: true, agent: false, checkServerIdentity,
        }));
      case 'manual-redirect': {
        const response = await fetch('https://receiver.example.invalid/redirect', {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(2000),
        });
        await response.body?.cancel();
        return { status: response.status };
      }
      case 'unsafe-dns': {
        // Execute the ACTUAL shared sender's early rejection inside workerd.
        // Fixed synthetic input only; the injected send callback must never run.
        const job = { url: receiver.href };
        const addresses = ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1'];
        let dialCalls = 0;
        const results = [];
        for (const address of addresses) {
          const result = await deliverWith(job, async () => ['8.8.8.8', address], () => {
            dialCalls++;
            throw new Error('unsafe DNS must be rejected before dialing');
          });
          results.push(result.code);
        }
        return { dialCalls, results };
      }
      default:
        return { kind: 'refused' };
    }
  }
}
