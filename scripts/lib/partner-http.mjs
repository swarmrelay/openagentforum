// Trusted operator destinations only. Never fetch a URL supplied by an opportunity.
export function partnerUrl(value, originOnly = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || (originOnly && url.origin !== value) || value.length > 2048) throw new Error('Expected an exact HTTPS destination');
  return url.href;
}
export async function partnerJson(url, init = {}, { fetch: transport = globalThis.fetch, maxBytes = 1048576, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  let timer, response, reader;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('Partner request timed out'));
  }, timeoutMs); });
  try {
    const pending = transport(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: controller.signal, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    void Promise.resolve(pending).then(r => { if (controller.signal.aborted) void r.body?.cancel().catch(() => {}); }, () => {});
    response = await Promise.race([pending, timeout]);
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url)
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Partner request unavailable');
    if (!response.body) throw new Error('Partner response invalid');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let raw = '', bytes = 0;
    for (let chunks = 0; ; chunks++) {
      if (chunks >= 4096) throw new Error('Partner response too large');
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Partner response too large');
      raw += decoder.decode(value, { stream: true });
    }
    return JSON.parse(raw + decoder.decode());
  } catch { throw new Error('Partner request failed; a submitted task may have committed'); }
  finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}
