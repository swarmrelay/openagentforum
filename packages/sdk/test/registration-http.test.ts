import { afterEach, expect, it, vi } from 'vitest';
import { RegistrationError, registrationRequest } from '../src/registration-http.js';

const url = 'https://relay.test/v1/agents/register';
const privateDetail = 'untrusted-relay-detail-not-for-errors';
afterEach(() => { vi.useRealTimers(); });

it.each([undefined, '{}'])('uses bounded, credential-free, no-store transport for body %s', async body => {
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  expect(await registrationRequest(fetcher, url, body)).toEqual({ ok: true });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({
    method: body === undefined ? 'GET' : 'POST', body,
    redirect: 'error', cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal),
  }));
});

it.each(['oversizedHeader', 'badHeader', 'oversizedStream', 'html', 'malformedJson', 'badUtf8', 'redirected', 'noBody'])('rejects %s without reflecting relay content', async kind => {
  let response: Response;
  if (kind === 'noBody') response = new Response(null, { headers: { 'Content-Type': 'application/json' } });
  else if (kind === 'badUtf8') response = new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } });
  else if (kind === 'html' || kind === 'malformedJson') response = new Response(privateDetail, {
    headers: { 'Content-Type': kind === 'html' ? 'text/html' : 'application/json' },
  });
  else {
    response = Response.json({ value: kind === 'oversizedStream' ? 'x'.repeat(32 * 1024) : privateDetail });
    if (kind === 'oversizedHeader') response.headers.set('Content-Length', '32769');
    if (kind === 'badHeader') response.headers.set('Content-Length', 'invalid');
    if (kind === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
  }
  const error = await registrationRequest(async () => response, url, '{}').catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('Invalid registration response; retain the exact proof for reconciliation');
  expect(error.message).not.toContain(privateDetail);
});

it.each([403, 409, 429, 503])('reports HTTP %s with an unusable error body without retrying', async status => {
  const cancel = vi.fn();
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status }));
  const error = await registrationRequest(fetcher, url, '{}').catch(e => e);
  expect(error).toBeInstanceOf(RegistrationError);
  expect(error).toMatchObject({ status, code: undefined, recovery: status === 403 || status === 409 ? 'reconcile' : 'retry-exact' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it.each([
  [409, 'registration_not_applied', 'reconcile'], [409, 'display_name_claimed', 'reconcile'],
  [403, 'invalid_registration_proof', 'reconcile'], [400, 'reserved_agent_name', 'reconcile'],
  [503, 'registration_outcome_unknown', 'retry-exact'], [503, 'registration_not_configured', 'reconcile'],
  [408, 'registration_read_timeout', 'retry-exact'],
] as const)('exposes only a validated code for HTTP %s / %s', async (status, code, recovery) => {
  const fetcher = vi.fn(async () => Response.json({ error: code, message: privateDetail, stack: privateDetail }, { status }));
  const error = await registrationRequest(fetcher, url, '{}').catch(e => e);
  expect(error).toBeInstanceOf(RegistrationError);
  expect(error).toMatchObject({ status, code, recovery });
  expect(JSON.stringify(error)).not.toContain(privateDetail);
  expect(error.message).not.toContain(privateDetail);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['unknown', 'wrongStatus', 'oversized', 'malformed', 'redirected'])('does not trust a %s error body', async kind => {
  const response = kind === 'malformed' ? new Response('{', { status: 503, headers: { 'content-type': 'application/json' } })
    : Response.json({ error: kind === 'unknown' ? privateDetail : 'display_name_claimed', detail: kind === 'oversized' ? 'x'.repeat(32768) : privateDetail },
      { status: kind === 'oversized' || kind === 'redirected' ? 409 : 503 });
  if (kind === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
  const error = await registrationRequest(async () => response, url, '{}').catch(e => e);
  expect(error).toBeInstanceOf(RegistrationError);
  expect(error.code).toBeUndefined();
  expect(error.message).not.toContain(privateDetail);
});

it('sanitizes transport failures and does not retry', async () => {
  const fetcher = vi.fn(async () => { throw new Error(privateDetail); });
  await expect(registrationRequest(fetcher, url, '{}')).rejects.toThrow('Registration request failed; retain the exact proof');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['fetch', 'body'])('bounds a stalled %s even when the custom transport ignores abort', async stage => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const cancel = vi.fn();
  const fetcher = vi.fn(async (_: string, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    if (stage === 'fetch') return new Promise<Response>(() => {});
    return new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } });
  });
  const assertion = expect(registrationRequest(fetcher, url, '{}')).rejects.toThrow('Registration request timed out; retain the exact proof');
  await vi.advanceTimersByTimeAsync(10_001);
  await assertion;
  expect(signal?.aborted).toBe(true);
  if (stage === 'body') expect(cancel).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds empty chunks without waiting forever for the byte budget or clock', async () => {
  const cancel = vi.fn();
  let reads = 0;
  const body = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel,
  });
  await expect(registrationRequest(async () => new Response(body, {
    headers: { 'Content-Type': 'application/json' },
  }), url, '{}')).rejects.toThrow('Invalid registration response');
  expect(reads).toBeLessThanOrEqual(4098);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('does not await an uncooperative stream cancellation', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream({ cancel });
  await expect(registrationRequest(async () => new Response(body, { status: 503 }), url, '{}')).rejects.toThrow('HTTP 503');
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('copies reused Buffer-backed chunks before requesting the next chunk', async () => {
  const buffer = Buffer.alloc(10);
  const chunks = ['{"x":"aa",', '"y":"bb"} '];
  const body = new ReadableStream({ pull(controller) {
    const chunk = chunks.shift();
    if (chunk === undefined) { controller.close(); return; }
    buffer.write(chunk);
    controller.enqueue(buffer);
  } }, { highWaterMark: 0 });
  expect(await registrationRequest(async () => new Response(body, {
    headers: { 'Content-Type': 'application/json' },
  }), url)).toEqual({ x: 'aa', y: 'bb' });
});
