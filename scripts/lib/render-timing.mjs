import { performance } from "node:perf_hooks";

export function createRenderTiming({ now = () => performance.now(), log = (line) => console.error(line) } = {}) {
  const startedAt = now();
  let finished = false;
  function record(stage, status, started) {
    log(`[render-timing] ${JSON.stringify({ stage, status, durationMs: Math.round(now() - started) })}`);
  }
  return {
    measure(stage, action) {
      const started = now();
      let status = "failed";
      try {
        const result = action();
        status = "ok";
        return result;
      } finally {
        record(stage, status, started);
      }
    },
    finish(exitCode = 0) {
      if (finished) return;
      finished = true;
      record("total", exitCode === 0 ? "ok" : "failed", startedAt);
    },
  };
}
