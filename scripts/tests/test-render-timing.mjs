import assert from "node:assert/strict";
import { createRenderTiming } from "../lib/render-timing.mjs";

let elapsed = 10;
const lines = [];
const timing = createRenderTiming({ now: () => elapsed, log: (line) => lines.push(line) });
const result = timing.measure("preflight", () => {
  elapsed += 25;
  return { valid: true };
});
assert.deepEqual(result, { valid: true });
const failure = new Error("private-file-and-secret");
assert.throws(() => timing.measure("body.inspect", () => {
  elapsed += 40;
  throw failure;
}), (error) => error === failure);
elapsed += 5;
timing.finish(1);
timing.finish(0);
assert.deepEqual(lines.map((line) => JSON.parse(line.replace("[render-timing] ", ""))), [
  { stage: "preflight", status: "ok", durationMs: 25 },
  { stage: "body.inspect", status: "failed", durationMs: 40 },
  { stage: "total", status: "failed", durationMs: 70 },
]);
assert.equal(lines.join(" ").includes(failure.message), false);
console.log("render stage timing tests: ok");
