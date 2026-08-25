import assert from "node:assert/strict";
import {
  DEFAULT_FIRST_FRAME_TITLE_HOLD_SECONDS,
  DEFAULT_FIRST_FRAME_TITLE_SOURCE_SECONDS,
  buildFirstFrameCoverSourceCandidates,
  resolveFirstFrameTitleConfig,
} from "../lib/first-frame-title.mjs";

assert.deepEqual(resolveFirstFrameTitleConfig({}), {
  holdSeconds: DEFAULT_FIRST_FRAME_TITLE_HOLD_SECONDS,
  sourceSeconds: DEFAULT_FIRST_FRAME_TITLE_SOURCE_SECONDS,
});
assert.deepEqual(resolveFirstFrameTitleConfig({
  firstFrameTitleHoldSeconds: 0,
  firstFrameTitleSourceSeconds: 0.4,
}), {
  holdSeconds: 0,
  sourceSeconds: 0.4,
});
assert.deepEqual(
  buildFirstFrameCoverSourceCandidates(0, 8, 1 / 30),
  [0, 0.9, 1.5, 2, 2.5, 4, 6],
);
assert.deepEqual(buildFirstFrameCoverSourceCandidates(0, 0.5, 1 / 30), [0, 0.125, 0.25, 0.375]);
assert.deepEqual(buildFirstFrameCoverSourceCandidates(0, 0, 1 / 30), []);

console.log("first frame title: ok");
