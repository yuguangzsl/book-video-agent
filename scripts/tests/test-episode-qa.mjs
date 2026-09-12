import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateEpisodeQa } from "../lib/episode-qa.mjs";
import { sha256File } from "../lib/render-manifest.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-qa-"));
const episodeDir = path.join(root, "episodes", "测试书");
fs.mkdirSync(path.join(episodeDir, "audio"), { recursive: true });
fs.mkdirSync(path.join(episodeDir, "renders"), { recursive: true });
for (const [relative, content] of [
  ["script.csv", "script"],
  ["audio/body-voiceover.mp3", "audio"],
  ["renders/final.mp4", "video"],
  ["renders/final.manifest.json", "manifest"],
]) {
  fs.writeFileSync(path.join(episodeDir, relative), content);
}
const completed = {
  episodeDir,
  episodeName: "测试书",
  scriptVersion: "v1",
  outputPath: path.join(episodeDir, "renders", "final.mp4"),
  manifestPath: path.join(episodeDir, "renders", "final.manifest.json"),
  manifest: { output: { sha256: sha256File(path.join(episodeDir, "renders", "final.mp4")) } },
  paths: {
    scriptPath: path.join(episodeDir, "script.csv"),
    bodyVoicePath: path.join(episodeDir, "audio", "body-voiceover.mp3"),
  },
};
const checkedAt = "2026-09-03T00:00:00.000Z";
const qa = {
  schemaVersion: 1,
  status: "passed",
  draftSha256: "d".repeat(64),
  episodeName: completed.episodeName,
  scriptVersion: completed.scriptVersion,
  reworkCount: 2,
  bindings: {
    scriptSha256: sha256File(completed.paths.scriptPath),
    audioSha256: sha256File(completed.paths.bodyVoicePath),
    renderSha256: completed.manifest.output.sha256,
    renderManifestSha256: sha256File(completed.manifestPath),
  },
  objectiveChecks: { passed: true },
  asrSampleWindows: [
    { position: "opening", startSeconds: 0, endSeconds: 8 },
    { position: "middle", startSeconds: 21, endSeconds: 29 },
    { position: "ending", startSeconds: 42, endSeconds: 50 },
  ],
  semanticReview: {
    status: "passed",
    reviewer: "codex-vision",
    checkedAt,
    titleAuthorVisible: true,
    framesOnTheme: true,
    captionsUnobstructed: true,
    scenesDistinct: true,
  },
  asrReview: {
    status: "passed",
    reviewer: "whisper-independent",
    checkedAt,
    samples: [
      { position: "opening", startSeconds: 0, endSeconds: 8 },
      { position: "middle", startSeconds: 21, endSeconds: 29 },
      { position: "ending", startSeconds: 42, endSeconds: 50 },
    ].map((sample) => ({
      ...sample,
      match: true,
      transcript: `${sample.position} transcript`,
      scriptExcerpt: `${sample.position} script`,
      similarity: 0.9,
    })),
  },
};
fs.writeFileSync(path.join(episodeDir, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`);
assert.equal(validateEpisodeQa(root, completed).qa.status, "passed");
fs.appendFileSync(completed.paths.scriptPath, "changed");
assert.throws(() => validateEpisodeQa(root, completed), /script hash changed/u);
