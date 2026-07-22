import fs from "node:fs";
import path from "node:path";
import {
  assertPortableProjectPath,
  formatMarkdownLocalPath,
  resolveProjectPath,
  toPortableProjectPath,
} from "./artifact-paths.mjs";
import {
  assertTtsUnitsMatchScript,
  buildCaptionTimings,
  buildEdgeSubtitleSegments,
  validateCaptionTimings,
} from "./body-timings.mjs";
import { readPublishJson, validatePublishJsonAgainstManifest } from "./publish-json.mjs";
import { readJsonFile } from "./json.mjs";
import { readAndValidateRenderManifest, sha256File } from "./render-manifest.mjs";
import { readScriptRows } from "./script-csv.mjs";
import { validateBodyScript } from "./script-policy.mjs";
import { resolveScriptVersion } from "./script-version.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return readJsonFile(filePath);
}

function requireFile(filePath, label) {
  assert(fs.existsSync(filePath) && fs.statSync(filePath).isFile(), `Missing ${label}: ${filePath}`);
  return filePath;
}

function resolveTimingReference(root, value, field, options = {}) {
  let reference = value;
  try {
    assertPortableProjectPath(reference, field);
  } catch (error) {
    if (!options.allowLegacy || typeof reference !== "string" || !reference.includes("\\")) throw error;
    reference = reference.replaceAll("\\", "/");
    assertPortableProjectPath(reference, field);
    options.warnings?.push(`${field} uses legacy backslashes; regenerate timings to normalize it`);
  }
  return requireFile(resolveProjectPath(root, reference, field), field);
}

function validateTimingReference(root, timings, field, options = {}) {
  const filePath = resolveTimingReference(root, timings[field], `body-timings.${field}`, options);
  const hashField = `${field}Sha256`;
  if (options.allowLegacy && !timings[hashField]) return filePath;
  assert(typeof timings[hashField] === "string" && /^[a-f0-9]{64}$/iu.test(timings[hashField]), `body-timings.${hashField} must be a sha256 hex string`);
  assert(sha256File(filePath) === timings[hashField].toLowerCase(), `body-timings.${hashField} does not match ${timings[field]}`);
  return filePath;
}

function assertSameCaptionTimings(actual, expected) {
  assert(actual.length === expected.length, "Edge TTS caption count does not match body-timings.json");
  actual.forEach((caption, index) => {
    const target = expected[index];
    assert(Number(caption.order) === Number(target.order), `Edge TTS caption order mismatch at ${index}`);
    assert(Math.abs(Number(caption.start) - Number(target.start)) <= 0.011, `Caption ${caption.order} start does not match Edge TTS word boundaries`);
    assert(Math.abs(Number(caption.end) - Number(target.end)) <= 0.011, `Caption ${caption.order} end does not match Edge TTS word boundaries`);
  });
}

export function validateBodyTimingArtifact(root, timingsPath, scriptVersion, rows, options = {}) {
  const timings = readJson(timingsPath);
  const warnings = [];
  const allowLegacy = Boolean(options.allowLegacy);
  if (timings.schemaVersion !== 1) {
    assert(allowLegacy, "body-timings.json schemaVersion must be 1; regenerate timings with create-body-timings.mjs");
    warnings.push("body-timings.json is legacy and has no source-file hashes; it is accepted only for auditing an existing render");
  } else {
    assert(typeof timings.duration === "number", "body-timings.duration must be a number");
    assert(Number.isInteger(timings.skipLeadingSegments) && timings.skipLeadingSegments >= 0, "body-timings.skipLeadingSegments must be a non-negative integer");
    assert(typeof timings.source === "string" && timings.source.trim(), "body-timings.source must be a non-empty string");
    assert(
      Array.isArray(timings.captions)
      && timings.captions.every((caption) => Number.isInteger(caption?.order) && typeof caption.start === "number" && typeof caption.end === "number"),
      "body-timings.captions must use numeric order, start, and end values",
    );
  }
  assert(timings.scriptVersion === scriptVersion, `body-timings.json is for ${timings.scriptVersion || "unknown"}, not ${scriptVersion}`);
  const orders = rows.map((row) => Number(row.order));
  validateCaptionTimings(timings.captions, orders, Number(timings.duration));
  const referenceOptions = { allowLegacy, warnings };
  const audioPath = validateTimingReference(root, timings, "audio", referenceOptions);
  if (timings.asr) {
    try {
      validateTimingReference(root, timings, "asr", referenceOptions);
    } catch (error) {
      if (!allowLegacy || !String(error.message).startsWith("Missing body-timings.asr:")) throw error;
      warnings.push("body-timings.asr references a removed legacy diagnostic file");
    }
  }

  const sourceKind = timings.sourceKind
    || (allowLegacy && String(timings.source || "").startsWith("node-edge-tts") ? "edge-tts" : null)
    || (allowLegacy && String(timings.source || "").includes("silencedetect") ? "speech-pause" : null);
  if (sourceKind === "edge-tts") {
    const edgeSubtitlesPath = validateTimingReference(root, timings, "edgeSubtitles", referenceOptions);
    const skipLeading = Math.max(0, Number(timings.skipLeadingSegments) || 0);
    let ttsUnits = null;
    if (timings.ttsInput) {
      const ttsInputPath = validateTimingReference(root, timings, "ttsInput", referenceOptions);
      ttsUnits = fs.readFileSync(ttsInputPath, "utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      assert(ttsUnits.length === rows.length + skipLeading, `TTS input unit count mismatch: found ${ttsUnits.length}, need ${rows.length + skipLeading}`);
      assertTtsUnitsMatchScript(ttsUnits, rows.map((row) => row.text), skipLeading);
    } else {
      assert(allowLegacy, "body-timings.ttsInput must be a non-empty string");
      warnings.push("legacy Edge TTS timings have no TTS input copy; text-to-boundary identity cannot be re-verified");
    }
    const edgeItems = readJson(edgeSubtitlesPath);
    const expectedSegments = buildEdgeSubtitleSegments(edgeItems, ttsUnits);
    const expectedCaptions = buildCaptionTimings(orders, expectedSegments, skipLeading);
    assertSameCaptionTimings(timings.captions, expectedCaptions);
  } else if (sourceKind === "speech-pause") {
    warnings.push("body-timings.json uses speech-pause fallback; semantic line alignment still requires manual spot-checking");
  } else {
    throw new Error(`Unsupported body-timings.json sourceKind: ${timings.sourceKind || "missing"}`);
  }

  return { timings, audioPath, warnings };
}

function resolveEpisodeDirectory(root, episodeName) {
  const episodesRoot = path.resolve(root, "episodes");
  const episodeDir = path.resolve(episodesRoot, episodeName);
  assert(path.dirname(episodeDir) === episodesRoot, `Episode name must identify one direct child of episodes/: ${episodeName}`);
  assert(fs.existsSync(episodeDir) && fs.statSync(episodeDir).isDirectory(), `Episode not found: ${episodeDir}`);
  return episodeDir;
}

export function validateEpisodeForRender(root, episodeName, requestedVersion = "", options = {}) {
  const episodeDir = resolveEpisodeDirectory(root, episodeName);
  const scriptVersion = resolveScriptVersion(episodeDir, requestedVersion);
  const briefPath = requireFile(path.join(episodeDir, "brief.json"), "brief.json");
  const scriptPath = requireFile(path.join(episodeDir, "script.csv"), "script.csv");
  const timingsPath = requireFile(path.join(episodeDir, "audio", "body-timings.json"), "body-timings.json");
  const bodyVoicePath = requireFile(path.join(episodeDir, "audio", "body-voiceover.mp3"), "body voiceover");
  const rows = readScriptRows(scriptPath, scriptVersion);
  assert(
    rows.every((row, index) => Number(row.order) === index + 1 && String(row.text || "").trim()),
    "script.csv active rows must have non-empty text and contiguous order values starting at 1",
  );
  const scriptValidation = validateBodyScript(rows);
  assert(scriptValidation.errors.length === 0, scriptValidation.errors.join("；"));
  const timingResult = validateBodyTimingArtifact(root, timingsPath, scriptVersion, rows, {
    allowLegacy: options.allowLegacyTimings,
  });
  if (normalizeAbsolutePath(timingResult.audioPath) !== normalizeAbsolutePath(bodyVoicePath)) {
    assert(options.allowLegacyTimings, "body-timings.audio must reference the body-voiceover.mp3 used by the renderer");
    timingResult.warnings.push("legacy timings reference a derived or different audio file; the existing manifest is checked, but a rerender requires regenerated timings");
  }

  const imagePaths = ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"]
    .map((name) => requireFile(path.join(episodeDir, "images", name), name));
  const imageHashes = imagePaths.map(sha256File);
  assert(new Set(imageHashes).size === imageHashes.length, "Episode images contain duplicate file content");

  return {
    episodeDir,
    episodeName,
    scriptVersion,
    paths: { briefPath, scriptPath, timingsPath, bodyVoicePath, imagePaths },
    rows,
    timings: timingResult.timings,
    warnings: timingResult.warnings,
  };
}

function normalizeAbsolutePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validateQueueItem(root, episodeName, outputPath, manifest, publish) {
  const queuePath = path.join(root, ".agents", "publish-queue.json");
  if (!fs.existsSync(queuePath)) return [];
  const queue = readJson(queuePath);
  assert(Array.isArray(queue.items), `${queuePath}: items must be an array`);
  const matches = queue.items.filter((item) => item?.book === episodeName);
  assert(matches.length <= 1, `${queuePath}: duplicate queue entries for ${episodeName}`);
  if (matches.length === 0) return [];
  const item = matches[0];
  assert(typeof item.videoPath === "string" && path.isAbsolute(item.videoPath), `${queuePath}: videoPath must be absolute`);
  assert(normalizeAbsolutePath(item.videoPath) === normalizeAbsolutePath(outputPath), `${queuePath}: videoPath does not match render manifest`);
  assert(item.scriptVersion === manifest.episode.scriptVersion, `${queuePath}: scriptVersion does not match render manifest`);
  assert(String(item.renderSha256).toLowerCase() === manifest.output.sha256.toLowerCase(), `${queuePath}: renderSha256 does not match render manifest`);
  if (publish) {
    assert(item.title === publish.copy.selectedTitle, `${queuePath}: title does not match publish.json`);
    assert(item.description === publish.copy.description, `${queuePath}: description does not match publish.json`);
  }
  return [];
}

export function validateCompletedEpisode(root, episodeName, requestedVersion = "", options = {}) {
  const preflight = validateEpisodeForRender(root, episodeName, requestedVersion, {
    allowLegacyTimings: options.allowLegacyTimings ?? true,
  });
  const rendersDir = path.join(preflight.episodeDir, "renders");
  assert(fs.existsSync(rendersDir), `Missing renders directory: ${rendersDir}`);
  const renderEntries = fs.readdirSync(rendersDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  const manifests = renderEntries.filter((entry) => entry.name.endsWith(".manifest.json")).map((entry) => entry.name);
  const videos = renderEntries.filter((entry) => entry.name.toLowerCase().endsWith(".mp4")).map((entry) => entry.name);
  assert(manifests.length === 1, `Expected exactly one render manifest for ${episodeName}, found ${manifests.length}`);
  assert(videos.length === 1, `Expected exactly one final MP4 for ${episodeName}, found ${videos.length}`);
  const manifestPath = path.join(rendersDir, manifests[0]);
  const manifestResult = readAndValidateRenderManifest(root, manifestPath, {
    verifyMedia: true,
    probeMedia: options.mediaProbe,
  });
  const { manifest } = manifestResult;
  assert(manifest.episode.name === episodeName, "render manifest episode.name does not match episode directory");
  assert(manifest.episode.scriptVersion === preflight.scriptVersion, "render manifest scriptVersion does not match active script");
  assert(manifest.inputs.script.file === toPortableProjectPath(root, preflight.paths.scriptPath), "render manifest script path does not match active script.csv");
  assert(manifest.inputs.brief.file === toPortableProjectPath(root, preflight.paths.briefPath), "render manifest brief path does not match active brief.json");
  assert(manifest.inputs.timings.file === toPortableProjectPath(root, preflight.paths.timingsPath), "render manifest timings path does not match active body-timings.json");
  assert(manifest.audioMix.bodyVoice.file === toPortableProjectPath(root, preflight.paths.bodyVoicePath), "render manifest bodyVoice path does not match active voiceover");
  const expectedImagePaths = preflight.paths.imagePaths.map((imagePath) => toPortableProjectPath(root, imagePath));
  assert(
    manifest.inputs.images.map((item) => item.file).every((file, index) => file === expectedImagePaths[index]),
    "render manifest image paths do not match active episode images",
  );
  const outputPath = resolveProjectPath(root, manifest.output.file, "manifest output.file");
  assert(path.basename(outputPath) === videos[0], "render manifest output.file does not match the active MP4");

  const publishPath = path.join(preflight.episodeDir, "publish.json");
  let publish = null;
  if (fs.existsSync(publishPath)) {
    publish = readPublishJson(publishPath);
    validatePublishJsonAgainstManifest(publish, manifest, publishPath);
  } else if (options.requirePublish) {
    throw new Error(`Missing publish.json: ${publishPath}`);
  }
  validateQueueItem(root, episodeName, outputPath, manifest, publish);

  return {
    ...preflight,
    manifest,
    manifestPath,
    outputPath,
    publish,
    publishPath,
    warnings: [...preflight.warnings, ...manifestResult.warnings],
  };
}

export function formatCompletedEpisodeDelivery(result) {
  assert(result.publish, `Missing publish.json: ${result.publishPath}`);
  return [
    `视频文件路径：[打开视频](${formatMarkdownLocalPath(result.outputPath)})`,
    `标题：${result.publish.copy.selectedTitle}`,
    `简介：${result.publish.copy.description}`,
  ].join("\n");
}
