import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatCompletedEpisodeDelivery,
  validateCompletedEpisode,
  validateEpisodeForRender,
} from "../lib/episode-checks.mjs";
import { describeManifestFile, sha256File } from "../lib/render-manifest.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-episode-check-test-"));
const episodeName = "测试书";
const episodeDir = path.join(root, "episodes", episodeName);
const audioDir = path.join(episodeDir, "audio");
const imagesDir = path.join(episodeDir, "images");
const rendersDir = path.join(episodeDir, "renders");
const assetsDir = path.join(root, "assets");

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

try {
  const briefPath = path.join(episodeDir, "brief.json");
  const scriptPath = path.join(episodeDir, "script.csv");
  const bodyVoicePath = path.join(audioDir, "body-voiceover.mp3");
  const edgePath = path.join(audioDir, "body-voiceover.edge-timings.json");
  const ttsInputPath = path.join(audioDir, "body-voiceover-input.txt");
  const asrPath = path.join(audioDir, "asr", "body.json");
  const timingsPath = path.join(audioDir, "body-timings.json");
  const introVoicePath = path.join(assetsDir, "template-audio", "intro-voiceover.mp3");
  const bgmPath = path.join(assetsDir, "bgm", "test.mp3");
  const sfxPath = path.join(assetsDir, "sfx", "gear-scroll.mp3");
  const introTemplatePath = path.join(root, "templates", "shared-video-template", "intro");
  const imagePaths = ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"]
    .map((name) => path.join(imagesDir, name));

  write(briefPath, `${JSON.stringify({ display_title: episodeName, author: "作者", scriptVersion: "v1" })}\n`);
  write(scriptPath, "version,order,text\nv1,1,第一行。\nv1,2,第二行。\n");
  write(bodyVoicePath, "voice");
  write(edgePath, `${JSON.stringify([
    { part: "《测试书》。", start: 0, end: 1000 },
    { part: "第一行。", start: 1500, end: 2400 },
    { part: "第二行。", start: 2900, end: 3900 },
  ])}\n`);
  write(ttsInputPath, "《测试书》。\n第一行。\n第二行。\n");
  write(asrPath, "{}\n");
  const timings = {
    schemaVersion: 1,
    scriptVersion: "v1",
    duration: 4.1,
    source: "node-edge-tts word boundaries; script.csv remains subtitle truth",
    sourceKind: "edge-tts",
    audio: "episodes/测试书/audio/body-voiceover.mp3",
    audioSha256: sha256File(bodyVoicePath),
    asr: "episodes/测试书/audio/asr/body.json",
    asrSha256: sha256File(asrPath),
    skipLeadingSegments: 1,
    edgeSubtitles: "episodes/测试书/audio/body-voiceover.edge-timings.json",
    edgeSubtitlesSha256: sha256File(edgePath),
    ttsInput: "episodes/测试书/audio/body-voiceover-input.txt",
    ttsInputSha256: sha256File(ttsInputPath),
    captions: [
      { order: 1, start: 1.5, end: 2.4 },
      { order: 2, start: 2.9, end: 3.9 },
    ],
  };
  write(timingsPath, `${JSON.stringify(timings, null, 2)}\n`);
  imagePaths.forEach((imagePath, index) => write(imagePath, `image-${index}`));
  write(path.join(introTemplatePath, "index.html"), "template");
  write(introVoicePath, "intro");
  write(bgmPath, "bgm");
  write(sfxPath, "sfx");

  const preflight = validateEpisodeForRender(root, episodeName);
  assert.equal(preflight.scriptVersion, "v1");
  assert.equal(preflight.rows.length, 2);
  assert.deepEqual(preflight.warnings, []);
  write(bodyVoicePath, "changed voice");
  assert.throws(() => validateEpisodeForRender(root, episodeName), /audioSha256 does not match/);
  write(bodyVoicePath, "voice");

  write(timingsPath, `${JSON.stringify({ ...timings, audio: "episodes\\测试书\\audio\\body-voiceover.mp3" }, null, 2)}\n`);
  assert.throws(() => validateEpisodeForRender(root, episodeName), /forward slashes/);
  write(timingsPath, `${JSON.stringify(timings, null, 2)}\n`);
  const otherVoicePath = path.join(audioDir, "other.mp3");
  write(otherVoicePath, "other voice");
  write(timingsPath, `${JSON.stringify({
    ...timings,
    audio: "episodes/测试书/audio/other.mp3",
    audioSha256: sha256File(otherVoicePath),
  }, null, 2)}\n`);
  assert.throws(() => validateEpisodeForRender(root, episodeName), /must reference the body-voiceover\.mp3/);
  write(timingsPath, `${JSON.stringify(timings, null, 2)}\n`);
  const {
    schemaVersion: _schemaVersion,
    sourceKind: _sourceKind,
    audioSha256: _audioSha256,
    asrSha256: _asrSha256,
    edgeSubtitlesSha256: _edgeSubtitlesSha256,
    ttsInputSha256: _ttsInputSha256,
    ...legacyTimings
  } = timings;
  write(timingsPath, `${JSON.stringify(legacyTimings, null, 2)}\n`);
  assert.throws(() => validateEpisodeForRender(root, episodeName), /schemaVersion must be 1/);
  assert.match(
    validateEpisodeForRender(root, episodeName, "", { allowLegacyTimings: true }).warnings.join("\n"),
    /accepted only for auditing an existing render/,
  );
  write(timingsPath, `${JSON.stringify(timings, null, 2)}\n`);

  const outputPath = path.join(rendersDir, "test-final.mp4");
  const manifestPath = path.join(rendersDir, "test-final.manifest.json");
  write(outputPath, "video");
  const manifest = {
    schemaVersion: 1,
    kind: "book-video-render",
    createdAt: "2026-07-22T12:00:00.000Z",
    episode: { name: episodeName, slug: "test", scriptVersion: "v1" },
    output: {
      ...describeManifestFile(root, outputPath),
      durationSeconds: 6.48,
      video: { codec: "h264", width: 720, height: 960, frameRate: 30 },
      audio: { codec: "aac", sampleRate: 48000, channels: 2 },
    },
    render: { hyperframesVersion: "0.7.33", quality: "standard", introTrimSeconds: 2.38, maximumDurationSeconds: 60 },
    audioMix: {
      voicePreset: "story",
      bgm: { name: "test.mp3", selection: "explicit", ...describeManifestFile(root, bgmPath) },
      introVoice: describeManifestFile(root, introVoicePath),
      bodyVoice: describeManifestFile(root, bodyVoicePath),
      scrollSfx: describeManifestFile(root, sfxPath),
    },
    inputs: {
      brief: describeManifestFile(root, briefPath),
      script: describeManifestFile(root, scriptPath),
      timings: describeManifestFile(root, timingsPath),
      images: imagePaths.map((imagePath) => describeManifestFile(root, imagePath)),
      introTemplate: "templates/shared-video-template/intro",
    },
  };
  write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const publish = {
    schemaVersion: 1,
    book: episodeName,
    generatedAt: "2026-07-22T12:05:00+08:00",
    inputs: {
      scriptVersion: "v1",
      scriptSha256: manifest.inputs.script.sha256,
      renderSha256: manifest.output.sha256,
    },
    research: {
      scope: "test",
      popularVideoSampleStatus: "unavailable",
      notes: ["test"],
      attempts: [],
      videoSamples: [],
      fallbackSignals: [],
      patterns: ["test"],
    },
    copy: {
      titleCandidates: ["标题一", "标题二", "标题三"],
      selectedTitle: "标题一",
      description: "简介",
      hashtags: ["#1", "#2", "#3"],
      viralityDisclaimer: "test",
    },
  };
  write(path.join(episodeDir, "publish.json"), `${JSON.stringify(publish, null, 2)}\n`);
  write(path.join(root, ".agents", "publish-queue.json"), `${JSON.stringify({
    updatedAt: "2026-07-22T12:10:00+08:00",
    items: [{
      book: episodeName,
      videoPath: outputPath,
      title: publish.copy.selectedTitle,
      description: publish.copy.description,
      scriptVersion: "v1",
      renderSha256: manifest.output.sha256,
    }],
  }, null, 2)}\n`);

  const mediaProbe = () => ({
    durationSeconds: 6.48,
    video: { codec: "h264", width: 720, height: 960, frameRate: 30 },
    audio: { codec: "aac", sampleRate: 48000, channels: 2 },
  });
  const completed = validateCompletedEpisode(root, episodeName, "", { requirePublish: true, mediaProbe });
  assert.equal(completed.outputPath, outputPath);
  assert.deepEqual(completed.warnings, []);
  const delivery = formatCompletedEpisodeDelivery(completed);
  assert.match(
    delivery,
    /^\u89c6\u9891\u6587\u4ef6\u8def\u5f84：\[打开视频\]\(.+test-final\.mp4\)\n\n标题：\n```text\n标题一\n```\n\n简介：\n```text\n简介\n```$/u,
  );
  write(outputPath, "changed video");
  assert.throws(() => validateCompletedEpisode(root, episodeName, "", { mediaProbe }), /output\.(bytes|sha256) does not match/);
  write(outputPath, "video");

  assert.throws(
    () => validateCompletedEpisode(root, episodeName, "", {
      mediaProbe: () => ({ ...mediaProbe(), video: { ...mediaProbe().video, width: 1080 } }),
    }),
    /dimensions.*do not match actual MP4/u,
  );

  write(path.join(episodeDir, "publish.json"), `${JSON.stringify({
    ...publish,
    inputs: { ...publish.inputs, renderSha256: "0".repeat(64) },
  }, null, 2)}\n`);
  assert.throws(
    () => validateCompletedEpisode(root, episodeName, "", { mediaProbe }),
    /renderSha256 does not match render manifest/,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("episode checks: ok");
