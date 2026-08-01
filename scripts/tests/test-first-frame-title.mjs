import assert from "node:assert/strict";
import {
  DEFAULT_FIRST_FRAME_TITLE_HOLD_SECONDS,
  DEFAULT_FIRST_FRAME_TITLE_SOURCE_SECONDS,
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

console.log("first frame title: ok");
