import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTempWorkspace,
  readManagedTempWorkspaceMetadata,
} from "../lib/temp-lifecycle.mjs";
import { buildEdgeSubtitleSegments } from "../lib/body-timings.mjs";
import {
  assertVoiceoverResumeWorkspaceOwnership,
  buildBodyTtsChunks,
  buildBodyTtsUnits,
  callEdgeTtsWithSocketCleanup,
  createOrResumeVoiceoverCheckpoint,
  edgeSubtitleOutputPath,
  getVoiceoverCheckpointChunkPaths,
  recordVoiceoverCheckpointChunk,
  ensureTtsSentenceTerminator,
  validateVoiceoverCheckpointChunk,
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

function nativeBoundaries(units) {
  let start = 0;
  return units.map((part) => {
    const end = start + 100;
    const item = { part, start, end };
    start = end;
    return item;
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-voiceover-checkpoint-test-"));
const episode = "检查点测试书";
const scriptVersion = "v1";
const ttsUnits = buildBodyTtsUnits(episode, [{ text: "第一句。" }, { text: "第二句。" }]);
const chunks = buildBodyTtsChunks(ttsUnits, 10);
const ttsOptions = {
  voice: "zh-CN-YunxiNeural",
  lang: "zh-CN",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  rate: "-8%",
  pitch: "-2Hz",
  timeout: 30000,
  proxy: "http://proxy.example.test:8080",
};

try {
  const workspace = createTempWorkspace(root, {
    kind: "voiceover",
    label: "checkpoint",
    owner: "prepare-body-voiceover.mjs",
    details: { episode, scriptVersion },
  });
  const metadata = readManagedTempWorkspaceMetadata(root, workspace);
  assertVoiceoverResumeWorkspaceOwnership(metadata, episode, scriptVersion);
  assert.throws(
    () => assertVoiceoverResumeWorkspaceOwnership(metadata, "另一部书", scriptVersion),
    /does not belong/u,
  );

  const manifest = createOrResumeVoiceoverCheckpoint({
    workspace,
    episode,
    scriptVersion,
    ttsUnits,
    ttsOptions,
    chunks,
  });
  assert.deepEqual(manifest.input.units, ttsUnits);
  assert.equal(manifest.options.proxy, undefined);
  assert.match(manifest.options.proxySha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(manifest.chunkPlan.map((chunk) => chunk.units), chunks);

  const firstPaths = getVoiceoverCheckpointChunkPaths(workspace, 0);
  const firstBoundaries = nativeBoundaries(chunks[0]);
  fs.mkdirSync(path.dirname(firstPaths.audioPath), { recursive: true });
  fs.writeFileSync(firstPaths.audioPath, Buffer.from("complete chunk audio"));
  fs.writeFileSync(firstPaths.boundariesPath, `${JSON.stringify(firstBoundaries)}\n`);
  recordVoiceoverCheckpointChunk({
    workspace,
    manifest,
    index: 0,
    expectedUnits: chunks[0],
    validateBoundaries: buildEdgeSubtitleSegments,
  });

  const resumed = createOrResumeVoiceoverCheckpoint({
    workspace,
    resume: true,
    episode,
    scriptVersion,
    ttsUnits,
    ttsOptions,
    chunks,
  });
  const reusable = validateVoiceoverCheckpointChunk({
    workspace,
    manifest: resumed,
    index: 0,
    expectedUnits: chunks[0],
    validateBoundaries: buildEdgeSubtitleSegments,
  });
  assert.equal(reusable.audioPath, firstPaths.audioPath);
  assert.deepEqual(reusable.boundaries, firstBoundaries);
  assert.equal(validateVoiceoverCheckpointChunk({
    workspace,
    manifest: resumed,
    index: 1,
    expectedUnits: chunks[1],
    validateBoundaries: buildEdgeSubtitleSegments,
  }), null, "an interrupted run must reuse only completed chunks");

  fs.rmSync(firstPaths.boundariesPath);
  assert.throws(() => validateVoiceoverCheckpointChunk({
    workspace,
    manifest: resumed,
    index: 0,
    expectedUnits: chunks[0],
    validateBoundaries: buildEdgeSubtitleSegments,
  }), /boundaries are missing/u);

  fs.writeFileSync(firstPaths.boundariesPath, `${JSON.stringify(firstBoundaries)}\n`);
  fs.writeFileSync(firstPaths.audioPath, Buffer.from("tampered chunk audio"));
  assert.throws(() => validateVoiceoverCheckpointChunk({
    workspace,
    manifest: resumed,
    index: 0,
    expectedUnits: chunks[0],
    validateBoundaries: buildEdgeSubtitleSegments,
  }), /audio hash mismatch/u);
  assert.throws(() => createOrResumeVoiceoverCheckpoint({
    workspace,
    resume: true,
    episode,
    scriptVersion,
    ttsUnits: [...ttsUnits, "额外输入。"],
    ttsOptions,
    chunks,
  }), /input does not match/u);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const socket = {
  terminated: false,
  terminate() {
    this.terminated = true;
  },
};
const fakeTts = {
  async _connectWebSocket() {
    return socket;
  },
  async call() {
    await this._connectWebSocket();
    throw new Error("ECONNRESET");
  },
};
const originalConnect = fakeTts._connectWebSocket;
await assert.rejects(() => callEdgeTtsWithSocketCleanup(fakeTts, "测试"), /ECONNRESET/u);
assert.equal(socket.terminated, true, "a failed Edge TTS call must terminate its captured socket");
assert.equal(fakeTts._connectWebSocket, originalConnect, "the TTS connection method must be restored after a failure");

console.log("voiceover preparation: ok");
