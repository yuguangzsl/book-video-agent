import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeFirstFramePixels,
  assertFirstFrameCover,
  assertManifestMediaMatches,
  describeManifestFile,
} from "../lib/render-manifest.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-manifest-test-"));
const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-manifest-external-"));

try {
  const projectFile = path.join(root, "episodes", "book", "script.csv");
  const externalFile = path.join(externalRoot, "music.mp3");
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, "version,order,text\nv1,1,test\n");
  fs.writeFileSync(externalFile, "audio");

  const projectRecord = describeManifestFile(root, projectFile);
  assert.equal(projectRecord.file, "episodes/book/script.csv");
  assert.equal(projectRecord.location, "project");
  assert.match(projectRecord.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(projectRecord.bytes, fs.statSync(projectFile).size);

  const externalRecord = describeManifestFile(root, externalFile);
  assert.equal(externalRecord.file, "music.mp3");
  assert.equal(externalRecord.location, "external");
  assert.equal(externalRecord.file.includes(externalRoot), false);

  const candidateOutput = path.join(root, "tmp", "candidate.mp4");
  const finalOutput = path.join(root, "episodes", "book", "renders", "final.mp4");
  fs.mkdirSync(path.dirname(candidateOutput), { recursive: true });
  fs.writeFileSync(candidateOutput, "video");
  const outputRecord = describeManifestFile(root, candidateOutput, { referencePath: finalOutput });
  assert.equal(outputRecord.file, "episodes/book/renders/final.mp4");
  assert.equal(outputRecord.location, "project");

  const media = {
    durationSeconds: 12.34,
    video: { codec: "h264", width: 720, height: 960, frameRate: 30 },
    audio: { codec: "aac", sampleRate: 48000, channels: 2 },
  };
  assert.doesNotThrow(() => assertManifestMediaMatches(media, { ...media, durationSeconds: 12.35 }));
  assert.throws(
    () => assertManifestMediaMatches(media, { ...media, video: { ...media.video, width: 1080 } }),
    /dimensions.*do not match actual MP4/u,
  );
  assert.throws(
    () => assertManifestMediaMatches(media, { ...media, audio: { ...media.audio, sampleRate: 44100 } }),
    /sample rate.*does not match actual MP4/u,
  );

  const blackFrame = analyzeFirstFramePixels(Buffer.alloc(100, 0), 10, 10);
  assert.throws(() => assertFirstFrameCover(blackFrame), /first frame cover is black or nearly black/u);
  const blackTitleCard = Buffer.alloc(100, 0);
  blackTitleCard.fill(255, 0, 10);
  assert.throws(
    () => assertFirstFrameCover(analyzeFirstFramePixels(blackTitleCard, 10, 10)),
    /first frame cover is black or nearly black/u,
  );
  const visibleFrame = Buffer.alloc(100, 64);
  assert.doesNotThrow(() => assertFirstFrameCover(analyzeFirstFramePixels(visibleFrame, 10, 10)));
  assert.throws(
    () => analyzeFirstFramePixels(Buffer.alloc(99, 64), 10, 10),
    /pixel bytes 99 do not match expected 100/u,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(externalRoot, { recursive: true, force: true });
}

console.log("render manifest tests: ok");
