import assert from "node:assert/strict";
import { createTtsPacing } from "../lib/tts-pacing.mjs";

function harness() {
  let clock = 0;
  const sleeps = [];
  const events = [];
  const pacing = createTtsPacing({
    now: () => clock,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    log: (event) => events.push(event),
  });
  return { pacing, sleeps, events, advance: (milliseconds) => { clock += milliseconds; } };
}

{
  const { pacing, sleeps, advance } = harness();
  const result = await pacing.synthesizeChunk(0, async () => { advance(8000); return "audio"; });
  assert.equal(result, "audio");
  assert.deepEqual(sleeps, [], "first actual request starts immediately");
  advance(1000);
  await pacing.synthesizeChunk(1, async () => { advance(2000); });
  assert.deepEqual(sleeps, [2000], "local validation counts toward the 3-second gap after completion");
  advance(4000);
  await pacing.synthesizeChunk(2, async () => {});
  assert.deepEqual(sleeps, [2000], "elapsed local work eliminates unnecessary sleeping");
  const summary = pacing.finish("succeeded");
  assert.equal(summary.requestMs, 10000);
  assert.equal(summary.waitMs, 2000);
  assert.equal(summary.elapsedMs, 17000);
}

{
  const { pacing, sleeps, events, advance } = harness();
  let attempts = 0;
  await pacing.synthesizeChunk(0, async () => {
    advance(100);
    if (++attempts === 1) throw new Error("secret proxy and private SSML");
  });
  await pacing.synthesizeChunk(1, async () => {});
  await pacing.synthesizeChunk(2, async () => {});
  assert.deepEqual(sleeps, [30000, 15000, 15000], "one failure keeps the remainder of this run conservative");
  const summary = pacing.finish("succeeded");
  assert.equal(summary.requests, 4);
  assert.equal(summary.retries, 1);
  assert.equal(summary.failures, 1);
  assert.equal(summary.requestMs, 200, "backoff is not counted as request duration");
  assert.equal(summary.waitMs, 60000);
  assert.equal(summary.conservative, true);
  assert.equal(JSON.stringify(events).includes("secret"), false, "timing logs never include request errors or content");
  assert.equal(events.filter((event) => event.event === "request-start").length, 4);
}

{
  const { pacing, sleeps } = harness();
  let attempts = 0;
  const error = new Error("service unavailable");
  await assert.rejects(() => pacing.synthesizeChunk(0, async () => { attempts += 1; throw error; }), (caught) => caught === error);
  assert.equal(attempts, 2, "at most one retry is permitted");
  assert.deepEqual(sleeps, [30000]);
  assert.equal(pacing.finish("failed").failures, 2);
}

{
  const { pacing, sleeps, advance } = harness();
  pacing.reuseChunk(0);
  pacing.reuseChunk(1);
  await pacing.synthesizeChunk(2, async () => {});
  assert.deepEqual(sleeps, [], "resuming at a later chunk does not delay the first actual request");
  pacing.reuseChunk(3);
  advance(1000);
  await pacing.synthesizeChunk(4, async () => {});
  assert.deepEqual(sleeps, [2000], "checkpoint reuse neither waits nor resets the actual request clock");
  assert.equal(pacing.finish("succeeded").reusedChunks, 3);
}

{
  const { pacing, sleeps } = harness();
  pacing.reuseChunk(0);
  pacing.reuseChunk(1);
  const summary = pacing.finish("succeeded");
  assert.deepEqual(sleeps, [], "an entirely cached voiceover never waits");
  assert.equal(summary.requests, 0);
  assert.equal(summary.retries, 0);
}

console.log("tts pacing: ok");
