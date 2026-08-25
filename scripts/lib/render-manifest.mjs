import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnCommandSync } from "./command.mjs";
import { readJsonFile } from "./json.mjs";
import {
  EPISODE_IMAGE_FILENAMES,
  FINAL_DURATION_TOLERANCE_SECONDS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from "./project-constants.mjs";
import {
  assertPortableProjectPath,
  resolveProjectPath,
  toPortableProjectPath,
} from "./artifact-paths.mjs";

export const FIRST_FRAME_MAX_BLACK_PIXEL_RATIO = 0.8;
export const FIRST_FRAME_MIN_MEAN_LUMA = 18;
export const FIRST_FRAME_BLACK_LUMA_THRESHOLD = 24;

export function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function describeManifestFile(root, filePath, options = {}) {
  const resolvedFile = path.resolve(filePath);
  const referencePath = path.resolve(options.referencePath || resolvedFile);
  let reference;
  let inProject = true;
  try {
    reference = toPortableProjectPath(root, referencePath);
  } catch {
    inProject = false;
    reference = path.basename(referencePath);
  }

  return {
    file: reference,
    location: inProject ? "project" : "external",
    bytes: fs.statSync(resolvedFile).size,
    sha256: sha256File(resolvedFile),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseFrameRate(value) {
  const [numerator, denominator] = String(value || "0/1").split("/").map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : 0;
}

export function analyzeFirstFramePixels(buffer, width, height) {
  assert(Buffer.isBuffer(buffer), "first frame pixels must be a Buffer");
  const expectedBytes = Number(width) * Number(height);
  assert(Number.isInteger(expectedBytes) && expectedBytes > 0, "first frame dimensions must be positive integers");
  assert(
    buffer.length === expectedBytes,
    `first frame pixel bytes ${buffer.length} do not match expected ${expectedBytes}`,
  );

  let lumaTotal = 0;
  let blackPixels = 0;
  for (const luma of buffer) {
    lumaTotal += luma;
    if (luma <= FIRST_FRAME_BLACK_LUMA_THRESHOLD) blackPixels += 1;
  }
  return {
    meanLuma: Number((lumaTotal / expectedBytes).toFixed(2)),
    blackPixelRatio: Number((blackPixels / expectedBytes).toFixed(4)),
    blackLumaThreshold: FIRST_FRAME_BLACK_LUMA_THRESHOLD,
  };
}

export function assertFirstFrameCover(firstFrame) {
  assert(firstFrame && typeof firstFrame === "object", "first frame cover metrics are missing");
  const meanLuma = Number(firstFrame.meanLuma);
  const blackPixelRatio = Number(firstFrame.blackPixelRatio);
  assert(Number.isFinite(meanLuma), "first frame cover mean luma is invalid");
  assert(Number.isFinite(blackPixelRatio), "first frame cover black pixel ratio is invalid");
  assert(
    meanLuma >= FIRST_FRAME_MIN_MEAN_LUMA
      && blackPixelRatio <= FIRST_FRAME_MAX_BLACK_PIXEL_RATIO,
    `first frame cover is black or nearly black (mean luma ${meanLuma.toFixed(2)}, black pixels ${(blackPixelRatio * 100).toFixed(1)}%; requires mean >= ${FIRST_FRAME_MIN_MEAN_LUMA} and black pixels <= ${(FIRST_FRAME_MAX_BLACK_PIXEL_RATIO * 100).toFixed(0)}%)`,
  );
}

export function probeVideoFrameLuma(filePath, video, timestampSeconds = 0) {
  const width = Number(video?.width || 0);
  const height = Number(video?.height || 0);
  assert(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0,
    `cannot probe first frame without valid video dimensions: ${filePath}`);
  assert(Number.isFinite(timestampSeconds) && timestampSeconds >= 0,
    `frame probe timestamp must be non-negative: ${timestampSeconds}`);
  const args = ["-v", "error", "-nostdin", "-i", filePath];
  if (timestampSeconds > 0) args.push("-ss", String(timestampSeconds));
  args.push(
    "-map", "0:v:0",
    "-frames:v", "1",
    "-vf", `scale=${width}:${height},format=gray`,
    "-pix_fmt", "gray",
    "-f", "rawvideo",
    "pipe:1",
  );
  const result = spawnCommandSync("ffmpeg", args, {
    encoding: "buffer",
    maxBuffer: Math.max(width * height + 1024 * 1024, 4 * 1024 * 1024),
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg frame probe failed for ${filePath}: ${String(result.stderr || result.error?.message || "unknown error").trim()}`);
  }
  return analyzeFirstFramePixels(result.stdout, width, height);
}

export function probeMediaFile(filePath) {
  const args = [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels:format=duration",
    "-of", "json",
    filePath,
  ];
  const result = spawnCommandSync("ffprobe", args);
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${String(result.stderr || result.error?.message || "unknown error").trim()}`);
  }
  const probe = JSON.parse(result.stdout);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration);
  assert(video, `ffprobe found no video stream: ${filePath}`);
  assert(audio, `ffprobe found no audio stream: ${filePath}`);
  assert(Number.isFinite(duration) && duration > 0, `ffprobe reported invalid duration for ${filePath}`);
  const frameRate = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate);
  const videoMetadata = {
    codec: video.codec_name || "unknown",
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    frameRate: Number(frameRate.toFixed(3)),
  };
  return {
    durationSeconds: Number(duration.toFixed(2)),
    video: videoMetadata,
    audio: {
      codec: audio.codec_name || "unknown",
      sampleRate: Number(audio.sample_rate || 0),
      channels: Number(audio.channels || 0),
    },
    firstFrame: probeVideoFrameLuma(filePath, videoMetadata),
  };
}

export function assertManifestMediaMatches(output, actual, options = {}) {
  const durationTolerance = options.durationTolerance ?? 0.02;
  const frameRateTolerance = options.frameRateTolerance ?? 0.01;
  assert(actual?.video?.width === output?.video?.width && actual?.video?.height === output?.video?.height,
    `manifest video dimensions ${output?.video?.width || 0}x${output?.video?.height || 0} do not match actual MP4 ${actual?.video?.width || 0}x${actual?.video?.height || 0}`);
  assert(actual.video.codec === output.video.codec,
    `manifest video codec ${output.video.codec} does not match actual MP4 ${actual.video.codec}`);
  assert(Math.abs(Number(actual.video.frameRate) - Number(output.video.frameRate)) <= frameRateTolerance,
    `manifest frame rate ${output.video.frameRate} does not match actual MP4 ${actual.video.frameRate}`);
  assert(actual?.audio?.codec === output?.audio?.codec,
    `manifest audio codec ${output?.audio?.codec || "missing"} does not match actual MP4 ${actual?.audio?.codec || "missing"}`);
  assert(actual.audio.sampleRate === output.audio.sampleRate,
    `manifest audio sample rate ${output.audio.sampleRate} does not match actual MP4 ${actual.audio.sampleRate}`);
  assert(actual.audio.channels === output.audio.channels,
    `manifest audio channels ${output.audio.channels} do not match actual MP4 ${actual.audio.channels}`);
  assert(Math.abs(Number(actual.durationSeconds) - Number(output.durationSeconds)) <= durationTolerance,
    `manifest duration ${output.durationSeconds} does not match actual MP4 ${actual.durationSeconds}`);
}

function validateDescriptor(root, descriptor, field, options = {}) {
  assert(descriptor && typeof descriptor === "object" && !Array.isArray(descriptor), `${field} must be an object`);
  assert(Number.isInteger(descriptor.bytes) && descriptor.bytes >= 0, `${field}.bytes must be a non-negative integer`);
  assert(typeof descriptor.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(descriptor.sha256), `${field}.sha256 must be a sha256 hex string`);

  if (descriptor.location === "external") {
    assert(typeof descriptor.file === "string" && descriptor.file.length > 0, `${field}.file must be a non-empty filename`);
    assert(path.basename(descriptor.file) === descriptor.file, `${field}.file must not expose an external path`);
    return { warning: `${field} is external and cannot be re-hashed from the manifest alone` };
  }

  assert(descriptor.location === "project", `${field}.location must be project or external`);
  assertPortableProjectPath(descriptor.file, `${field}.file`);
  const actualPath = options.actualPath || resolveProjectPath(root, descriptor.file, `${field}.file`);
  assert(fs.existsSync(actualPath), `${field}.file does not exist: ${descriptor.file}`);
  const stat = fs.statSync(actualPath);
  assert(stat.isFile(), `${field}.file is not a file: ${descriptor.file}`);
  assert(stat.size === descriptor.bytes, `${field}.bytes does not match ${descriptor.file}`);
  assert(sha256File(actualPath) === descriptor.sha256.toLowerCase(), `${field}.sha256 does not match ${descriptor.file}`);
  return {};
}

export function validateRenderManifest(root, manifest, options = {}) {
  const warnings = [];
  assert(manifest && typeof manifest === "object" && !Array.isArray(manifest), "render manifest root must be an object");
  assert(manifest.schemaVersion === 1, "render manifest schemaVersion must be 1");
  assert(manifest.kind === "book-video-render", "render manifest kind must be book-video-render");
  assert(typeof manifest.createdAt === "string" && Number.isFinite(Date.parse(manifest.createdAt)), "render manifest createdAt must be an ISO date");
  assert(manifest.episode && typeof manifest.episode === "object", "render manifest episode must be an object");
  assert(typeof manifest.episode.name === "string" && manifest.episode.name.trim(), "render manifest episode.name is required");
  assert(typeof manifest.episode.slug === "string" && manifest.episode.slug.trim(), "render manifest episode.slug is required");
  assert(typeof manifest.episode.scriptVersion === "string" && manifest.episode.scriptVersion.trim(), "render manifest episode.scriptVersion is required");

  const descriptors = [
    [manifest.output, "output"],
    [manifest.audioMix?.bgm, "audioMix.bgm"],
    [manifest.audioMix?.introVoice, "audioMix.introVoice"],
    [manifest.audioMix?.bodyVoice, "audioMix.bodyVoice"],
    [manifest.audioMix?.scrollSfx, "audioMix.scrollSfx"],
    [manifest.inputs?.brief, "inputs.brief"],
    [manifest.inputs?.script, "inputs.script"],
    [manifest.inputs?.timings, "inputs.timings"],
    ...((manifest.inputs?.images || []).map((item, index) => [item, `inputs.images[${index}]`])),
  ];
  assert(
    Array.isArray(manifest.inputs?.images) && manifest.inputs.images.length === EPISODE_IMAGE_FILENAMES.length,
    `render manifest must describe exactly ${EPISODE_IMAGE_FILENAMES.length} images`,
  );
  for (const [descriptor, field] of [
    [manifest.output, "output"],
    [manifest.audioMix?.introVoice, "audioMix.introVoice"],
    [manifest.audioMix?.bodyVoice, "audioMix.bodyVoice"],
    [manifest.audioMix?.scrollSfx, "audioMix.scrollSfx"],
    [manifest.inputs?.brief, "inputs.brief"],
    [manifest.inputs?.script, "inputs.script"],
    [manifest.inputs?.timings, "inputs.timings"],
    ...manifest.inputs.images.map((item, index) => [item, `inputs.images[${index}]`]),
  ]) {
    assert(descriptor?.location === "project", `${field}.location must be project`);
  }

  for (const [descriptor, field] of descriptors) {
    const actualPath = options.fileOverrides?.[descriptor?.file];
    const result = validateDescriptor(root, descriptor, field, { actualPath });
    if (result.warning) warnings.push(result.warning);
  }

  assertPortableProjectPath(manifest.inputs.introTemplate, "inputs.introTemplate");
  const introTemplatePath = resolveProjectPath(root, manifest.inputs.introTemplate, "inputs.introTemplate");
  assert(fs.existsSync(introTemplatePath) && fs.statSync(introTemplatePath).isDirectory(), "inputs.introTemplate must reference an existing directory");
  assert(
    manifest.output.video?.width === VIDEO_WIDTH && manifest.output.video?.height === VIDEO_HEIGHT,
    `render manifest output must be ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`,
  );
  assert(manifest.output.audio && Number(manifest.output.audio.channels) > 0, "render manifest output must have audio");
  assert(Number.isFinite(manifest.output.durationSeconds) && manifest.output.durationSeconds > 0, "render manifest duration must be positive");
  if (manifest.render?.maximumDurationSeconds !== null) {
    assert(
      Number.isFinite(manifest.render?.maximumDurationSeconds)
      && manifest.output.durationSeconds <= manifest.render.maximumDurationSeconds + FINAL_DURATION_TOLERANCE_SECONDS,
      "render manifest duration exceeds the configured maximum",
    );
  }

  const imageHashes = manifest.inputs.images.map((item) => item.sha256.toLowerCase());
  assert(new Set(imageHashes).size === imageHashes.length, "render manifest contains duplicate image content");
  return { warnings };
}

export function readAndValidateRenderManifest(root, manifestPath, options = {}) {
  const manifest = readJsonFile(manifestPath);
  const result = validateRenderManifest(root, manifest, options);
  if (!options.skipManifestPathCheck) {
    assert(/\.mp4$/iu.test(manifest.output.file), "output.file must end with .mp4");
    const expectedManifestPath = resolveProjectPath(
      root,
      manifest.output.file.replace(/\.mp4$/iu, ".manifest.json"),
      "output manifest path",
    );
    assert(path.resolve(manifestPath) === expectedManifestPath, `manifest filename does not match output.file: ${manifestPath}`);
  }
  let media = null;
  if (options.verifyMedia) {
    const outputPath = options.fileOverrides?.[manifest.output.file]
      || resolveProjectPath(root, manifest.output.file, "output.file");
    media = (options.probeMedia || probeMediaFile)(outputPath);
    assertManifestMediaMatches(manifest.output, media, options);
    assertFirstFrameCover(media.firstFrame);
  }
  return { manifest, media, ...result };
}
