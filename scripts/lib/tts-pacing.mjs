import { performance } from "node:perf_hooks";

const HEALTHY_INTERVAL_MS = 3000;
const CONSERVATIVE_INTERVAL_MS = 15000;
const RETRY_DELAY_MS = 30000;

// One instance belongs to one sequential voiceover run. Checkpoint reads never
// advance the network clock; local work counts toward the next request's gap.
export function createTtsPacing({
  now = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  log = (event) => console.log(`[tts] ${JSON.stringify(event)}`),
} = {}) {
  const startedAt = now();
  let lastRequestEndedAt = null;
  let conservative = false;
  const totals = { requests: 0, retries: 0, failures: 0, reusedChunks: 0, requestMs: 0, waitMs: 0 };

  async function wait(milliseconds, chunk, attempt, reason) {
    if (milliseconds <= 0) return;
    const start = now();
    log({ event: "wait-start", chunk, attempt, reason, plannedMs: Math.ceil(milliseconds) });
    await sleep(milliseconds);
    const elapsedMs = now() - start;
    totals.waitMs += elapsedMs;
    log({ event: "wait-end", chunk, attempt, reason, elapsedMs: Math.round(elapsedMs) });
  }

  return {
    reuseChunk(index) {
      totals.reusedChunks += 1;
      log({ event: "checkpoint-reused", chunk: index + 1 });
    },
    async synthesizeChunk(index, request) {
      const chunk = index + 1;
      if (lastRequestEndedAt !== null) {
        const intervalMs = conservative ? CONSERVATIVE_INTERVAL_MS : HEALTHY_INTERVAL_MS;
        await wait(intervalMs - (now() - lastRequestEndedAt), chunk, 1, "request-interval");
      }
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const requestStartedAt = now();
        totals.requests += 1;
        log({ event: "request-start", chunk, attempt, conservative });
        let retry = false;
        try {
          const result = await request();
          log({ event: "request-end", chunk, attempt, status: "succeeded", elapsedMs: Math.round(now() - requestStartedAt) });
          return result;
        } catch (error) {
          conservative = true;
          totals.failures += 1;
          // Errors can contain SSML, proxy credentials, or service payloads.
          log({ event: "request-end", chunk, attempt, status: "failed", elapsedMs: Math.round(now() - requestStartedAt) });
          if (attempt === 2) throw error;
          retry = true;
        } finally {
          lastRequestEndedAt = now();
          totals.requestMs += lastRequestEndedAt - requestStartedAt;
        }
        if (retry) {
          totals.retries += 1;
          log({ event: "retry", chunk, attempt: 2, backoffMs: RETRY_DELAY_MS });
          await wait(RETRY_DELAY_MS, chunk, 2, "retry-backoff");
        }
      }
    },
    finish(status) {
      const summary = {
        event: "total", status, ...totals,
        requestMs: Math.round(totals.requestMs),
        waitMs: Math.round(totals.waitMs),
        elapsedMs: Math.round(now() - startedAt),
        conservative,
      };
      log(summary);
      return summary;
    },
  };
}
