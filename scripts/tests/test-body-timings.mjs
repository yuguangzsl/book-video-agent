import assert from "node:assert/strict";
import {
  assertTtsUnitsMatchScript,
  buildCaptionTimings,
  buildEdgeSubtitleSegments,
  buildSpeechSegments,
  coalesceSpeechSegments,
  parseSilenceEvents,
  validateCaptionTimings,
} from "../lib/body-timings.mjs";

const events = parseSilenceEvents(`silence_start: 0\nsilence_end: 0.4\nsilence_start: 1.9\nsilence_end: 2.6\nsilence_start: 3.7\nsilence_end: 4.4\nsilence_start: 5.5`);
const segments = buildSpeechSegments(6, events);
assert.deepEqual(segments, [
  { start: 0.4, end: 1.9 },
  { start: 2.6, end: 3.7 },
  { start: 4.4, end: 5.5 },
]);
assert.deepEqual(buildCaptionTimings([1, 2], segments, 1), [
  { order: 1, start: 2.6, end: 3.7 },
  { order: 2, start: 4.4, end: 5.5 },
]);
assert.deepEqual(coalesceSpeechSegments([
  { start: 0.4, end: 1.9 },
  { start: 2.6, end: 3.7 },
  { start: 3.9, end: 4.6 },
], 2), [
  { start: 0.4, end: 1.9 },
  { start: 2.6, end: 4.6 },
]);
assert.throws(() => buildCaptionTimings([1, 2, 3], segments, 1), /Speech segment count mismatch/);
assert.deepEqual(buildEdgeSubtitleSegments([
  { part: "《书名》。", start: 100, end: 900 },
  { part: "第一", start: 1500, end: 1800 },
  { part: "行。", start: 1800, end: 2300 },
  { part: "第二行。", start: 2900, end: 3600 },
]), [
  { start: 0.1, end: 0.9 },
  { start: 1.5, end: 2.3 },
  { start: 2.9, end: 3.6 },
]);
assert.deepEqual(buildEdgeSubtitleSegments([
  { part: "《书名》 ", start: 100, end: 900 },
  { part: "第一", start: 1500, end: 1800 },
  { part: "行。 ", start: 1800, end: 2300 },
  { part: "第二行。", start: 2900, end: 3600 },
], ["《书名》", "第一行。", "第二行。"]), [
  { start: 0.1, end: 0.9 },
  { start: 1.5, end: 2.3 },
  { start: 2.9, end: 3.6 },
]);
assert.doesNotThrow(() => assertTtsUnitsMatchScript(["《书名》。", "第一行。", "第二行。"], ["第一行", "第二行"], 1));
assert.throws(() => assertTtsUnitsMatchScript(["《书名》。", "错误文本。"], ["第一行"], 1), /does not match script\.csv/);
assert.doesNotThrow(() => validateCaptionTimings([
  { order: 1, start: 0.4, end: 1.9 },
  { order: 2, start: 2.6, end: 3.7 },
], [1, 2], 4));
assert.throws(() => validateCaptionTimings([
  { order: 1, start: 0.4, end: 1.9 },
  { order: 2, start: 1.8, end: 3.7 },
], [1, 2], 4), /overlaps/);
console.log("body timings: ok");
