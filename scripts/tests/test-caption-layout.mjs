import assert from "node:assert/strict";
import {
  buildCaptionInspectTimes,
  buildCaptionPresentationTiming,
  wrapCaptionLines,
} from "../lib/caption-layout.mjs";

assert.deepEqual(wrapCaptionLines("短句，下一句。"), ["短句，", "下一句。"]);
assert.deepEqual(wrapCaptionLines("一二三四五六七八九十", 6), ["一二三四五", "六七八九十"]);
assert.throws(() => wrapCaptionLines("文本", 0), /positive integer/u);

assert.deepEqual(
  buildCaptionPresentationTiming({ start: 1.5, end: 2.4 }),
  { start: 1, hold: 1.4 },
);
assert.deepEqual(
  buildCaptionPresentationTiming({ start: 0.2, end: 0.5 }),
  { start: 0, hold: 1 },
);
assert.throws(() => buildCaptionPresentationTiming({ start: "bad", end: 1 }), /finite/u);

assert.deepEqual(buildCaptionInspectTimes([
  { order: 1, start: 1.5 },
  { order: 2, start: 3.25 },
  { order: 3, start: 3.25 },
  { order: 4, start: 9.99 },
], 8), [1.5, 3.25, 7.99]);

console.log("caption layout: ok");
