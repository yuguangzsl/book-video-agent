import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileAtomically } from "./filesystem.mjs";
import { readJsonFile } from "./json.mjs";
import {
  FIRST_FRAME_MAX_BLACK_PIXEL_RATIO,
  FIRST_FRAME_MIN_MEAN_LUMA,
  probeVideoFrameLuma,
  sha256File,
} from "./render-manifest.mjs";
import { toPortableProjectPath } from "./artifact-paths.mjs";

export const EPISODE_QA_SCHEMA_VERSION = 1;
export const MAX_QA_REWORKS = 2;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runFfmpeg(args, options = {}) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], {
    cwd: options.cwd,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${String(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
  }
  return result;
}

function imageFingerprint(filePath) {
  const result = runFfmpeg(["-i", filePath, "-vf", "scale=16:16,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: null });
  const bytes = Buffer.from(result.stdout || []);
  assert(bytes.length === 256, `Could not fingerprint image: ${filePath}`);
  return bytes;
}

function imageSimilarity(left, right) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference += Math.abs(left[index] - right[index]);
  return 1 - difference / (left.length * 255);
}

function nearDuplicatePairs(imagePaths) {
  const fingerprints = imagePaths.map(imageFingerprint);
  const pairs = [];
  for (let left = 0; left < imagePaths.length; left += 1) {
    for (let right = left + 1; right < imagePaths.length; right += 1) {
      const similarity = imageSimilarity(fingerprints[left], fingerprints[right]);
      if (similarity >= 0.985) {
        pairs.push({ left: path.basename(imagePaths[left]), right: path.basename(imagePaths[right]), similarity: Number(similarity.toFixed(6)) });
      }
    }
  }
  return pairs;
}

function audioMetrics(audioPath) {
  const result = runFfmpeg(["-i", audioPath, "-af", "silencedetect=noise=-40dB:d=1.5,volumedetect", "-f", "null", "-"]);
  const log = String(result.stderr || "");
  const silenceDurations = [...log.matchAll(/silence_duration:\s*([0-9.]+)/gu)].map((match) => Number(match[1]));
  const meanVolume = Number(log.match(/mean_volume:\s*(-?[0-9.]+) dB/u)?.[1]);
  const maxVolume = Number(log.match(/max_volume:\s*(-?[0-9.]+) dB/u)?.[1]);
  assert(Number.isFinite(meanVolume) && Number.isFinite(maxVolume), "Could not read voiceover volume metrics");
  return {
    meanVolumeDb: meanVolume,
    maxVolumeDb: maxVolume,
    longestSilenceSeconds: silenceDurations.length ? Math.max(...silenceDurations) : 0,
    passed: meanVolume >= -35 && maxVolume <= -0.1 && silenceDurations.every((duration) => duration <= 3),
  };
}

function extractReviewFrames(root, completed, outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const duration = Number(completed.manifest.output.durationSeconds);
  const titleHold = Number(completed.manifest.render?.firstFrameTitle?.holdSeconds || 0);
  const introDuration = Number(completed.manifest.render?.introTrimSeconds || 0);
  const bodyDuration = Number(completed.timings.duration);
  const bodyStart = titleHold + introDuration;
  const samples = [
    { label: "cover", time: 0 },
    { label: "intro", time: titleHold + introDuration / 2 },
    ...completed.paths.imagePaths.map((_, index) => ({
      label: `body-scene-${index + 1}`,
      time: bodyStart + bodyDuration * index / completed.paths.imagePaths.length + 0.1,
    })),
    { label: "ending", time: Math.max(0, duration - 0.1) },
  ].map((sample) => ({
    ...sample,
    time: Math.min(Math.max(0, sample.time), Math.max(0, duration - 0.01)),
  })).filter((sample, index, values) => (
    values.findIndex((candidate) => Math.abs(candidate.time - sample.time) < 0.05) === index
  ));
  return samples.map(({ label, time }, index) => {
    const filePath = path.join(outputDirectory, `frame-${String(index + 1).padStart(2, "0")}-${label}-${time.toFixed(2)}s.png`);
    runFfmpeg(["-ss", time.toFixed(3), "-i", completed.outputPath, "-frames:v", "1", "-y", filePath]);
    assert(fs.existsSync(filePath), `QA frame was not created: ${filePath}`);
    const luma = probeVideoFrameLuma(completed.outputPath, completed.manifest.output.video, time);
    return {
      label,
      time,
      file: toPortableProjectPath(root, filePath),
      sha256: sha256File(filePath),
      luma,
      luminancePassed: luma.meanLuma >= FIRST_FRAME_MIN_MEAN_LUMA
        && luma.blackPixelRatio <= FIRST_FRAME_MAX_BLACK_PIXEL_RATIO,
    };
  });
}

export function episodeQaPath(completed) {
  return path.join(completed.episodeDir, "qa.json");
}

export function episodeQaDraftPath(completed) {
  return path.join(completed.episodeDir, "qa", completed.scriptVersion, "qa-draft.json");
}

export function prepareEpisodeQa(root, completed, options = {}) {
  const reworkCount = Number(options.reworkCount || 0);
  assert(Number.isInteger(reworkCount) && reworkCount >= 0 && reworkCount <= MAX_QA_REWORKS, `QA reworkCount must be between 0 and ${MAX_QA_REWORKS}`);
  const qaDir = path.dirname(episodeQaDraftPath(completed));
  const imageHashes = completed.paths.imagePaths.map((filePath) => ({
    file: toPortableProjectPath(root, filePath),
    sha256: sha256File(filePath),
  }));
  const nearDuplicates = nearDuplicatePairs(completed.paths.imagePaths);
  const audio = audioMetrics(completed.paths.bodyVoicePath);
  const frames = extractReviewFrames(root, completed, path.join(qaDir, "frames"));
  const brightnessPassed = frames.every((frame) => frame.luminancePassed);
  const audioDuration = Number(completed.timings.duration);
  const asrSampleWindows = [
    { position: "opening", startSeconds: 0, endSeconds: Math.min(8, audioDuration) },
    { position: "middle", startSeconds: Math.max(0, audioDuration / 2 - 4), endSeconds: Math.min(audioDuration, audioDuration / 2 + 4) },
    { position: "ending", startSeconds: Math.max(0, audioDuration - 8), endSeconds: audioDuration },
  ].map((sample) => ({
    ...sample,
    startSeconds: Number(sample.startSeconds.toFixed(3)),
    endSeconds: Number(sample.endSeconds.toFixed(3)),
  }));
  const draft = {
    schemaVersion: EPISODE_QA_SCHEMA_VERSION,
    status: "pending_review",
    episodeName: completed.episodeName,
    scriptVersion: completed.scriptVersion,
    preparedAt: options.now instanceof Date ? options.now.toISOString() : new Date().toISOString(),
    reworkCount,
    bindings: {
      scriptSha256: sha256File(completed.paths.scriptPath),
      audioSha256: sha256File(completed.paths.bodyVoicePath),
      renderSha256: completed.manifest.output.sha256.toLowerCase(),
      renderManifestSha256: sha256File(completed.manifestPath),
      images: imageHashes,
    },
    objectiveChecks: {
      exactImageHashesUnique: new Set(imageHashes.map((item) => item.sha256)).size === imageHashes.length,
      nearDuplicatePairs: nearDuplicates,
      brightnessPassed,
      audio,
      passed: nearDuplicates.length === 0 && brightnessPassed && audio.passed,
    },
    reviewFrames: frames,
    asrSampleWindows,
    requiredReview: {
      semantic: ["titleAuthorVisible", "framesOnTheme", "captionsUnobstructed", "scenesDistinct"],
      asrPositions: ["opening", "middle", "ending"],
    },
  };
  fs.mkdirSync(qaDir, { recursive: true });
  writeFileAtomically(episodeQaDraftPath(completed), `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8" });
  return draft;
}

function validateReview(review, expectedDraftSha256, expectedAsrWindows) {
  assert(review && typeof review === "object" && !Array.isArray(review), "QA review must be an object");
  assert(/^[a-f0-9]{64}$/u.test(String(review.draftSha256 || "")), "QA review must include draftSha256");
  assert(review.draftSha256 === expectedDraftSha256, "QA review does not match the current QA draft");
  const semantic = review.semanticReview;
  assert(semantic?.status === "passed", "QA semantic review must pass");
  assert(semantic.reviewer === "codex-vision", "QA semantic reviewer must be codex-vision");
  assert(Number.isFinite(Date.parse(semantic.checkedAt)), "QA semantic checkedAt must be an ISO date");
  for (const field of ["titleAuthorVisible", "framesOnTheme", "captionsUnobstructed", "scenesDistinct"]) {
    assert(semantic[field] === true, `QA semantic review requires ${field}=true`);
  }
  const asr = review.asrReview;
  assert(asr?.status === "passed", "QA ASR review must pass");
  assert(asr.reviewer === "whisper-independent", "QA ASR reviewer must be whisper-independent");
  assert(Number.isFinite(Date.parse(asr.checkedAt)), "QA ASR checkedAt must be an ISO date");
  assert(Array.isArray(asr.samples) && asr.samples.length === 3, "QA ASR review requires three samples");
  assert(Array.isArray(expectedAsrWindows) && expectedAsrWindows.length === 3, "QA draft must define three ASR sample windows");
  assert(expectedAsrWindows.every((window) => asr.samples.some((sample) => (
    sample.position === window.position
    && Math.abs(Number(sample.startSeconds) - window.startSeconds) <= 0.1
    && Math.abs(Number(sample.endSeconds) - window.endSeconds) <= 0.1
    && sample.match === true
    && typeof sample.transcript === "string" && sample.transcript.trim()
    && typeof sample.scriptExcerpt === "string" && sample.scriptExcerpt.trim()
    && Number(sample.similarity) >= 0.8 && Number(sample.similarity) <= 1
  ))), "QA ASR samples must include passing transcript comparisons for opening, middle, and ending");
  return { semantic, asr };
}

export function completeEpisodeQa(root, completed, review, options = {}) {
  const draftPath = episodeQaDraftPath(completed);
  assert(fs.existsSync(draftPath), `Missing QA draft: ${draftPath}`);
  const draft = readJsonFile(draftPath);
  assert(draft.objectiveChecks?.passed === true, "Objective QA checks failed; repair the affected media before review completion");
  const draftSha256 = sha256File(draftPath);
  const validatedReview = validateReview(review, draftSha256, draft.asrSampleWindows);
  const completedAt = options.now instanceof Date ? options.now.toISOString() : new Date().toISOString();
  const qa = {
    ...draft,
    status: "passed",
    completedAt,
    draftSha256,
    semanticReview: validatedReview.semantic,
    asrReview: validatedReview.asr,
  };
  writeFileAtomically(episodeQaPath(completed), `${JSON.stringify(qa, null, 2)}\n`, { encoding: "utf8" });
  return validateEpisodeQa(root, completed);
}

export function validateEpisodeQa(root, completed) {
  const filePath = episodeQaPath(completed);
  assert(fs.existsSync(filePath), `Missing qa.json: ${filePath}`);
  const qa = readJsonFile(filePath);
  assert(qa.schemaVersion === EPISODE_QA_SCHEMA_VERSION, `${filePath}: unsupported schemaVersion`);
  assert(qa.status === "passed", `${filePath}: QA status must be passed`);
  assert(qa.episodeName === completed.episodeName, `${filePath}: episodeName mismatch`);
  assert(qa.scriptVersion === completed.scriptVersion, `${filePath}: scriptVersion mismatch`);
  assert(qa.reworkCount >= 0 && qa.reworkCount <= MAX_QA_REWORKS, `${filePath}: invalid reworkCount`);
  assert(qa.bindings.scriptSha256 === sha256File(completed.paths.scriptPath), `${filePath}: script hash changed`);
  assert(qa.bindings.audioSha256 === sha256File(completed.paths.bodyVoicePath), `${filePath}: audio hash changed`);
  assert(qa.bindings.renderSha256 === completed.manifest.output.sha256.toLowerCase(), `${filePath}: render hash changed`);
  assert(qa.bindings.renderManifestSha256 === sha256File(completed.manifestPath), `${filePath}: render manifest hash changed`);
  assert(qa.objectiveChecks?.passed === true, `${filePath}: objective checks did not pass`);
  validateReview(qa, qa.draftSha256, qa.asrSampleWindows);
  return { qa, filePath };
}
