// A version that npm has just accepted can take a minute or more to be served
// (peer-stream 0.1.1, 2026-10-28: ~75 s), so a post-publish registry install can
// fail with "no matching version" for a release that is in fact fine. Retry only
// that error, a fixed number of times; every other failure stops at once.
export const REGISTRY_RETRY = Object.freeze({ attempts: 8, delayMs: 15_000 });

export const notYetServed = error => /npm (?:ERR!|error) code (?:ETARGET|E404)\b/.test(String(error?.stderr ?? ''));

export async function withRegistryRetry(run, { attempts = REGISTRY_RETRY.attempts, delayMs = REGISTRY_RETRY.delayMs,
  reset = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); } catch (error) {
      if (attempt >= attempts || !notYetServed(error)) throw error;
      // Fixed text only: installer output may contain local paths or server text.
      log(`Registry has not served the published version yet; retry ${attempt} of ${attempts - 1} in ${delayMs / 1000}s`);
      reset();
      await sleep(delayMs);
    }
  }
}
