import assert from "node:assert/strict";
import {
  buildBodyTtsChunks,
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
assert.deepEqual(buildBodyTtsChunks(["《书名》。", "第一行。", "第二行？"], 10), [
  ["《书名》。", "第一行。"],
  ["第二行？"],
]);
assert.deepEqual(buildBodyTtsChunks(["超过限制也必须保持完整句子。"], 5), [["超过限制也必须保持完整句子。"]]);
assert.throws(() => buildBodyTtsChunks(["第一行。"], 0), /Invalid TTS chunk size/);
assert.throws(() => ensureTtsSentenceTerminator(""), /must not be empty/);

console.log("voiceover preparation: ok");
