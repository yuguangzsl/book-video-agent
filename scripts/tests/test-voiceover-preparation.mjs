import assert from "node:assert/strict";
import {
  buildBodyTtsUnits,
  edgeSubtitleOutputPath,
  ensureTtsSentenceTerminator,
} from "../lib/voiceover-preparation.mjs";

assert.equal(ensureTtsSentenceTerminator("一句话"), "一句话。");
assert.equal(ensureTtsSentenceTerminator("一句话，"), "一句话。");
assert.equal(ensureTtsSentenceTerminator("一句话！"), "一句话！");
assert.deepEqual(buildBodyTtsUnits("《书名》", [
  { text: "第一行" },
  { text: "第二行？" },
]), ["《书名》。", "第一行。", "第二行？"]);
assert.equal(edgeSubtitleOutputPath("C:/tmp/body.mp3"), "C:/tmp/body.mp3.json");
assert.throws(() => ensureTtsSentenceTerminator(""), /must not be empty/);

console.log("voiceover preparation: ok");
