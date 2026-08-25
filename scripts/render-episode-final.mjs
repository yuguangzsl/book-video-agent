#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { runCommandSync } from "./lib/command.mjs";
import { buildCaptionInspectTimes } from "./lib/caption-layout.mjs";
import { validateEpisodeForRender } from "./lib/episode-checks.mjs";
import {
  assertFirstFrameCover,
  describeManifestFile,
  probeMediaFile,
  probeVideoFrameLuma,
  readAndValidateRenderManifest,
} from "./lib/render-manifest.mjs";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { replaceFilesWithRollback } from "./lib/file-transaction.mjs";
import { readJsonFile } from "./lib/json.mjs";
import { assertEpisodeCanRenderForReplenishment } from "./lib/replenishment-batch.mjs";
import {
  EPISODE_IMAGE_FILENAMES,
  FINAL_DURATION_TOLERANCE_SECONDS,
  HYPERFRAMES_CHECK_TIMEOUT_MS,
  HYPERFRAMES_VERSION,
  MAX_FINAL_DURATION_SECONDS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from "./lib/project-constants.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import {
  buildFirstFrameCoverSourceCandidates,
  resolveFirstFrameTitleConfig,
} from "./lib/first-frame-title.mjs";
import {
  TEMP_RETENTION_HOURS,
  createTempWorkspace,
  removeTempWorkspace,
  updateTempWorkspace,
} from "./lib/temp-lifecycle.mjs";

const ROOT = process.cwd();
const INTRO_TRIM_SECONDS = 2.38;
const INTRO_OFFSET_MS = Math.round(INTRO_TRIM_SECONDS * 1000);
const FINAL_BGM_BASE_VOLUME = 0.32;
const FINAL_BGM_GAIN_DB = Number(process.env.FINAL_BGM_GAIN_DB || "0");
if (!Number.isFinite(FINAL_BGM_GAIN_DB)) {
  throw new Error(`Invalid FINAL_BGM_GAIN_DB: ${process.env.FINAL_BGM_GAIN_DB}`);
}
const FINAL_BGM_VOLUME = Number((FINAL_BGM_BASE_VOLUME * Math.pow(10, FINAL_BGM_GAIN_DB / 20)).toFixed(4));
const ALLOW_OVER_60_SECONDS = process.env.ALLOW_OVER_60_SECONDS === "1";
const INTRO_SCROLL_SFX_START_SECONDS = 1.08;
const INTRO_SCROLL_SFX_END_SECONDS = 2.38;
const INTRO_SCROLL_SFX_FADE_OUT_SECONDS = 0.2;
const INTRO_SCROLL_SFX_VOLUME = 1.4;
const INTRO_SCROLL_SFX_PATH = path.join(ROOT, "assets", "sfx", "gear-scroll.mp3");
const INTRO_INSPECT_TIMES = [0.2, 0.75, 1.2, 1.7, 2.08, 2.25, 2.55, 3.2, 3.8, 4.15];
const FIRST_FRAME_RATE = 30;
const MAX_FIRST_FRAME_TITLE_HOLD_SECONDS = 3;

const [episodeName, requestedVersion, bgmInput] = process.argv.slice(2);

if (!episodeName) {
  console.error("Usage: node scripts/render-episode-final.mjs <episode-name> [script-version] [bgm-file-or-name]");
  process.exit(1);
}
assertEpisodeCanRenderForReplenishment(ROOT, episodeName);

function chooseRandomBgm() {
  const bgmDir = path.join(ROOT, "assets", "bgm");
  const available = fs.existsSync(bgmDir)
    ? fs.readdirSync(bgmDir).filter((name) => name.toLowerCase().endsWith(".mp3"))
    : [];
  if (available.length === 0) {
    throw new Error(`No shared BGM found in ${bgmDir}`);
  }
  return available[Math.floor(Math.random() * available.length)];
}

const bgmArg = bgmInput || chooseRandomBgm();

function slugifyBgmName(input) {
  const name = path.basename(input, path.extname(input));
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "bgm";
}

const slug = slugifyEpisodeName(episodeName);
const bgmSlug = slugifyBgmName(bgmArg);
const episodeDir = path.join(ROOT, "episodes", episodeName);
const scriptVersion = resolveScriptVersion(episodeDir, requestedVersion);
const briefPath = path.join(episodeDir, "brief.json");
const scriptPath = path.join(episodeDir, "script.csv");
const imagePaths = EPISODE_IMAGE_FILENAMES
  .map((name) => path.join(episodeDir, "images", name));
const audioDir = path.join(episodeDir, "audio");
const rendersDir = path.join(episodeDir, "renders");
const timingsPath = path.join(audioDir, "body-timings.json");
const introVoice = path.join(ROOT, "assets", "template-audio", "intro-voiceover.mp3");
const bodyVoice = path.join(audioDir, "body-voiceover.mp3");
const bgmMixSuffix =
  FINAL_BGM_GAIN_DB === 0
    ? "bgm-standard"
    : `bgm-mix-${FINAL_BGM_GAIN_DB > 0 ? "plus" : "minus"}${Math.abs(FINAL_BGM_GAIN_DB)}db`;
const outputPath = path.join(rendersDir, `${slug}-final-${bgmSlug}-story-voice-${bgmMixSuffix}.mp4`);
const manifestPath = outputPath.replace(/\.mp4$/u, ".manifest.json");
let previewDir;
let introDir;
let bodyDir;
let finalCandidateDir;
let introVideo;
let bodyVideo;
let introStoryVoice;
let bodyStoryVoice;
let candidateOutputPath;
let candidateContentOutputPath;
let candidateManifestPath;
const introScrollSfxDuration = Number((INTRO_SCROLL_SFX_END_SECONDS - INTRO_SCROLL_SFX_START_SECONDS).toFixed(2));
const introScrollSfxDelayMs = Math.round(INTRO_SCROLL_SFX_START_SECONDS * 1000);
const introScrollSfxFadeOutStart = Number((introScrollSfxDuration - INTRO_SCROLL_SFX_FADE_OUT_SECONDS).toFixed(2));

function run(command, args, options = {}) {
  return runCommandSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: "inherit",
    env: options.env || process.env,
  });
}

function validateHyperframesWorkspace(workspacePath, inspectTimes) {
  const packageName = `hyperframes@${HYPERFRAMES_VERSION}`;
  const env = {
    ...process.env,
    PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS: String(HYPERFRAMES_CHECK_TIMEOUT_MS),
  };
  run("npx", ["--yes", packageName, "lint", "--json", workspacePath], { env });
  run("npx", [
    "--yes", packageName, "validate", "--json", "--no-contrast",
    "--timeout", String(HYPERFRAMES_CHECK_TIMEOUT_MS), workspacePath,
  ], { env });
  const inspectArgs = [
    "--yes", packageName, "inspect", "--json",
    "--strict", "--timeout", String(HYPERFRAMES_CHECK_TIMEOUT_MS), "--at", inspectTimes.join(","), workspacePath,
  ];
  try {
    run("npx", inspectArgs, { env });
  } catch (error) {
    console.warn(`HyperFrames inspect failed once; retrying the same workspace and sample set: ${error.message}`);
    run("npx", inspectArgs, { env });
  }
}

function activateFinalRender(candidatePath, destinationPath, candidateManifest, destinationManifest) {
  fs.mkdirSync(rendersDir, { recursive: true });
  const activeFiles = new Set([destinationPath, destinationManifest]);
  const staleFiles = fs.readdirSync(rendersDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !activeFiles.has(path.join(rendersDir, entry.name)))
    .map((entry) => path.join(rendersDir, entry.name));
  const staleBackupDir = path.join(previewDir, "activation-backup", "stale-renders");
  replaceFilesWithRollback([
    { source: candidatePath, destination: destinationPath },
    { source: candidateManifest, destination: destinationManifest },
  ], path.join(previewDir, "activation-backup"), () => {
    const movedStaleFiles = [];
    try {
      readAndValidateRenderManifest(ROOT, destinationManifest, { verifyMedia: true });
      fs.mkdirSync(staleBackupDir, { recursive: true });
      for (const stalePath of staleFiles) {
        const backupPath = path.join(staleBackupDir, path.basename(stalePath));
        fs.renameSync(stalePath, backupPath);
        movedStaleFiles.push({ stalePath, backupPath });
      }
    } catch (error) {
      const restoreFailures = [];
      for (const item of movedStaleFiles.reverse()) {
        try {
          fs.renameSync(item.backupPath, item.stalePath);
        } catch (restoreError) {
          restoreFailures.push(`${item.stalePath}: ${restoreError.message}`);
        }
      }
      if (restoreFailures.length) {
        throw new Error(`${error.message}; stale render rollback also failed: ${restoreFailures.join(" | ")}`, { cause: error });
      }
      throw error;
    }
  });
}

function writeRenderManifest(filePath, mediaMetadata) {
  const manifest = {
    schemaVersion: 1,
    kind: "book-video-render",
    createdAt: new Date().toISOString(),
    episode: {
      name: episodeName,
      slug,
      scriptVersion,
    },
    output: {
      ...describeManifestFile(ROOT, candidateOutputPath, { referencePath: outputPath }),
      ...mediaMetadata,
    },
    render: {
      hyperframesVersion: HYPERFRAMES_VERSION,
      quality: "standard",
      introTrimSeconds: INTRO_TRIM_SECONDS,
      maximumDurationSeconds: ALLOW_OVER_60_SECONDS ? null : MAX_FINAL_DURATION_SECONDS,
      ...(firstFrameTitleEnabled
        ? {
            firstFrameTitle: {
              holdSeconds: firstFrameTitleHoldSeconds,
              source: "body",
              sourceSeconds: selectedFirstFrameTitleSourceSeconds,
            },
          }
        : {}),
    },
    audioMix: {
      voicePreset: "story",
      bgm: {
        name: path.basename(bgmPath),
        selection: bgmInput ? "explicit" : "random",
        ...describeManifestFile(ROOT, bgmPath),
        baseVolume: FINAL_BGM_BASE_VOLUME,
        gainDb: FINAL_BGM_GAIN_DB,
        appliedVolume: FINAL_BGM_VOLUME,
      },
      introVoice: describeManifestFile(ROOT, introVoice),
      bodyVoice: describeManifestFile(ROOT, bodyVoice),
      scrollSfx: describeManifestFile(ROOT, INTRO_SCROLL_SFX_PATH),
    },
    inputs: {
      brief: describeManifestFile(ROOT, briefPath),
      script: describeManifestFile(ROOT, scriptPath),
      timings: describeManifestFile(ROOT, timingsPath),
      images: imagePaths.map((imagePath) => describeManifestFile(ROOT, imagePath)),
      introTemplate: "templates/shared-video-template/intro",
    },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function getBgmPath(input) {
  const direct = path.resolve(ROOT, input);
  if (fs.existsSync(direct)) return direct;
  const withExt = input.endsWith(".mp3") ? input : `${input}.mp3`;
  const fromAssets = path.join(ROOT, "assets", "bgm", withExt);
  if (fs.existsSync(fromAssets)) return fromAssets;
  throw new Error(`BGM not found: ${input}`);
}

if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
if (!fs.existsSync(timingsPath)) throw new Error(`Missing timing file: ${timingsPath}`);
if (!fs.existsSync(introVoice)) {
  throw new Error(`Missing shared intro voiceover: ${introVoice}`);
}
if (!fs.existsSync(bodyVoice)) {
  throw new Error(`Missing episode body voiceover: ${bodyVoice}`);
}
if (!fs.existsSync(INTRO_SCROLL_SFX_PATH)) {
  throw new Error(`Missing intro scroll SFX: ${INTRO_SCROLL_SFX_PATH}`);
}

const bgmPath = getBgmPath(bgmArg);
console.log(`Using BGM: ${path.basename(bgmPath)}`);
const preflight = validateEpisodeForRender(ROOT, episodeName, scriptVersion);
for (const warning of preflight.warnings) console.warn(`Pre-render warning: ${warning}`);
const brief = readJsonFile(briefPath);
const firstFrameTitle = resolveFirstFrameTitleConfig(brief);
const firstFrameTitleHoldSeconds = Number(firstFrameTitle.holdSeconds);
const firstFrameTitleSourceSeconds = Number(firstFrameTitle.sourceSeconds);
let selectedFirstFrameTitleSourceSeconds = firstFrameTitleSourceSeconds;
if (
  !Number.isFinite(firstFrameTitleHoldSeconds)
  || firstFrameTitleHoldSeconds < 0
  || firstFrameTitleHoldSeconds > MAX_FIRST_FRAME_TITLE_HOLD_SECONDS
) {
  throw new Error(
    `brief.firstFrameTitleHoldSeconds must be between 0 and ${MAX_FIRST_FRAME_TITLE_HOLD_SECONDS}`,
  );
}
if (!Number.isFinite(firstFrameTitleSourceSeconds) || firstFrameTitleSourceSeconds < 0) {
  throw new Error("brief.firstFrameTitleSourceSeconds must be a non-negative number");
}
const firstFrameTitleEnabled = firstFrameTitleHoldSeconds > 0;
const firstFrameDurationSeconds = Number((1 / FIRST_FRAME_RATE).toFixed(6));
if (firstFrameTitleEnabled && firstFrameTitleHoldSeconds < firstFrameDurationSeconds) {
  throw new Error(`brief.firstFrameTitleHoldSeconds must be at least ${firstFrameDurationSeconds} when enabled`);
}
const configuredFirstFrameSourceEndSeconds = Number(
  (firstFrameTitleSourceSeconds + firstFrameDurationSeconds).toFixed(6),
);
const firstFrameStopPaddingSeconds = Number(
  Math.max(0, firstFrameTitleHoldSeconds - firstFrameDurationSeconds).toFixed(6),
);
const bodyDuration = Number(preflight.timings.duration);
if (firstFrameTitleEnabled && configuredFirstFrameSourceEndSeconds > bodyDuration) {
  throw new Error("brief.firstFrameTitleSourceSeconds must identify a frame inside the body video");
}
const contentDuration = Number((INTRO_TRIM_SECONDS + bodyDuration).toFixed(2));
const finalDuration = Number((firstFrameTitleHoldSeconds + contentDuration).toFixed(2));
if (finalDuration > MAX_FINAL_DURATION_SECONDS && !ALLOW_OVER_60_SECONDS) {
  throw new Error(`Planned final duration is ${finalDuration.toFixed(2)}s; maximum is ${MAX_FINAL_DURATION_SECONDS}s`);
}

previewDir = createTempWorkspace(ROOT, {
  kind: "render",
  label: slug,
  owner: "render-episode-final.mjs",
  retentionHours: TEMP_RETENTION_HOURS.active,
  details: { episode: episodeName, scriptVersion },
});
introDir = path.join(previewDir, "intro");
bodyDir = path.join(previewDir, "body");
finalCandidateDir = path.join(previewDir, "final");
introVideo = path.join(introDir, "renders", "intro.mp4");
bodyVideo = path.join(bodyDir, "renders", "body.mp4");
introStoryVoice = path.join(previewDir, "audio", "intro-voiceover-story.mp3");
bodyStoryVoice = path.join(previewDir, "audio", "body-voiceover-story.mp3");
candidateOutputPath = path.join(finalCandidateDir, path.basename(outputPath));
candidateContentOutputPath = firstFrameTitleEnabled
  ? path.join(finalCandidateDir, `${slug}-content-before-first-frame.mp4`)
  : candidateOutputPath;
candidateManifestPath = path.join(finalCandidateDir, path.basename(manifestPath));

try {
  fs.mkdirSync(rendersDir, { recursive: true });
  run("node", ["scripts/create-episode-preview.mjs", episodeName, scriptVersion], {
    env: { ...process.env, BOOK_VIDEO_WORK_DIR: previewDir },
  });
  validateHyperframesWorkspace(introDir, INTRO_INSPECT_TIMES);
  validateHyperframesWorkspace(bodyDir, buildCaptionInspectTimes(preflight.timings.captions, bodyDuration));
  fs.mkdirSync(finalCandidateDir, { recursive: true });
  run("node", ["scripts/process-voiceover.mjs", introVoice, introStoryVoice, "story"]);
  run("node", ["scripts/process-voiceover.mjs", bodyVoice, bodyStoryVoice, "story"]);
  run("npx", ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "render", "--quality", "standard", "--output", introVideo, introDir]);
  run("npx", ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "render", "--quality", "standard", "--output", bodyVideo, bodyDir]);

  run("ffmpeg", [
    "-y",
    "-i",
    introVideo,
    "-i",
    bodyVideo,
    "-i",
    introStoryVoice,
    "-i",
    bodyStoryVoice,
    "-stream_loop",
    "-1",
    "-i",
    bgmPath,
    "-i",
    INTRO_SCROLL_SFX_PATH,
    "-filter_complex",
    [
      `[0:v]trim=0:${INTRO_TRIM_SECONDS},setpts=PTS-STARTPTS[v0]`,
      `[1:v]trim=0:${bodyDuration},setpts=PTS-STARTPTS[v1]`,
      "[v0][v1]concat=n=2:v=1:a=0[v]",
      "[2:a]aresample=48000,volume=1.0[introa]",
      `[3:a]aresample=48000,adelay=${INTRO_OFFSET_MS}|${INTRO_OFFSET_MS},volume=1.0[bodya]`,
      `[4:a]atrim=0:${contentDuration},asetpts=PTS-STARTPTS,aresample=48000,volume=${FINAL_BGM_VOLUME}[bgm]`,
      `[5:a]atrim=0:${introScrollSfxDuration},asetpts=PTS-STARTPTS,aresample=48000,volume=${INTRO_SCROLL_SFX_VOLUME},afade=t=in:st=0:d=0.01,afade=t=out:st=${introScrollSfxFadeOutStart}:d=${INTRO_SCROLL_SFX_FADE_OUT_SECONDS},adelay=${introScrollSfxDelayMs}|${introScrollSfxDelayMs}[scrollsfx]`,
      "[introa][bodya][bgm][scrollsfx]amix=inputs=4:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,loudnorm=I=-14.0:TP=-1.0:LRA=7.0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]",
    ].join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-shortest",
    candidateContentOutputPath,
  ]);

  if (firstFrameTitleEnabled) {
    const coverCandidates = buildFirstFrameCoverSourceCandidates(
      firstFrameTitleSourceSeconds,
      bodyDuration,
      firstFrameDurationSeconds,
    );
    let selectedCover = null;
    const rejectedCovers = [];
    for (const sourceSeconds of coverCandidates) {
      const contentSourceSeconds = Number((INTRO_TRIM_SECONDS + sourceSeconds).toFixed(6));
      const metrics = probeVideoFrameLuma(
        candidateContentOutputPath,
        { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
        contentSourceSeconds,
      );
      try {
        assertFirstFrameCover(metrics);
        selectedCover = { sourceSeconds, metrics };
        break;
      } catch (error) {
        rejectedCovers.push(`${sourceSeconds.toFixed(3)}s: ${error.message}`);
      }
    }
    if (!selectedCover) {
      throw new Error(
        `Unable to find a non-black first-frame cover in the body video. Checked ${coverCandidates.length} frames. ${rejectedCovers.join(" | ")}`,
      );
    }
    selectedFirstFrameTitleSourceSeconds = selectedCover.sourceSeconds;
    console.log(
      `Selected first-frame cover at body ${selectedFirstFrameTitleSourceSeconds.toFixed(3)}s `
      + `(mean luma ${selectedCover.metrics.meanLuma.toFixed(2)}, black pixels ${(selectedCover.metrics.blackPixelRatio * 100).toFixed(1)}%)`,
    );
    const firstFrameContentSourceSeconds = Number(
      (INTRO_TRIM_SECONDS + selectedFirstFrameTitleSourceSeconds).toFixed(6),
    );
    const firstFrameContentSourceEndSeconds = Number(
      (firstFrameContentSourceSeconds + firstFrameDurationSeconds).toFixed(6),
    );
    run("ffmpeg", [
      "-y",
      "-i",
      candidateContentOutputPath,
      "-f",
      "lavfi",
      "-t",
      String(firstFrameTitleHoldSeconds),
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-filter_complex",
      [
        "[0:v]split=2[cover-source][content-source]",
        `[cover-source]trim=${firstFrameContentSourceSeconds}:${firstFrameContentSourceEndSeconds},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${firstFrameStopPaddingSeconds},fps=${FIRST_FRAME_RATE}[cover]`,
        "[content-source]setpts=PTS-STARTPTS[content]",
        "[cover][content]concat=n=2:v=1:a=0[v]",
        "[1:a]asetpts=PTS-STARTPTS[first-frame-silence]",
        "[0:a]asetpts=PTS-STARTPTS[content-audio]",
        "[first-frame-silence][content-audio]concat=n=2:v=0:a=1[a]",
      ].join(";"),
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-level",
      "4.1",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-shortest",
      candidateOutputPath,
    ]);
  }

  const mediaMetadata = probeMediaFile(candidateOutputPath);
  assertFirstFrameCover(mediaMetadata.firstFrame);
  if (mediaMetadata.video.width !== VIDEO_WIDTH || mediaMetadata.video.height !== VIDEO_HEIGHT) {
    throw new Error(`Invalid final video dimensions: ${mediaMetadata.video.width}x${mediaMetadata.video.height}`);
  }
  if (mediaMetadata.durationSeconds > MAX_FINAL_DURATION_SECONDS + FINAL_DURATION_TOLERANCE_SECONDS && !ALLOW_OVER_60_SECONDS) {
    throw new Error(`Final video is ${mediaMetadata.durationSeconds.toFixed(2)}s; maximum is ${MAX_FINAL_DURATION_SECONDS}s`);
  }
  writeRenderManifest(candidateManifestPath, mediaMetadata);
  const candidateManifest = readJsonFile(candidateManifestPath);
  readAndValidateRenderManifest(ROOT, candidateManifestPath, {
    skipManifestPathCheck: true,
    fileOverrides: { [candidateManifest.output.file]: candidateOutputPath },
  });
  activateFinalRender(candidateOutputPath, outputPath, candidateManifestPath, manifestPath);
  try {
    removeTempWorkspace(ROOT, previewDir);
  } catch (cleanupError) {
    try {
      updateTempWorkspace(ROOT, previewDir, {
        status: "cleanup-pending",
        retentionHours: 1,
        details: { stage: "complete", cleanupFailure: String(cleanupError.message || cleanupError).slice(0, 500) },
      });
    } catch {
      // The final output remains valid even if deferred-cleanup metadata cannot be updated.
    }
    console.warn(`Final render succeeded, but temporary cleanup was deferred: ${previewDir}`);
  }
  console.log(outputPath);
  console.log(manifestPath);
} catch (error) {
  try {
    updateTempWorkspace(ROOT, previewDir, {
      status: "failed",
      retentionHours: TEMP_RETENTION_HOURS.failed,
      details: { stage: "render", failure: String(error.message || error).slice(0, 500) },
    });
    console.error(`Temporary render workspace retained for diagnostics: ${previewDir}`);
  } catch {
    // Preserve the original render error if lifecycle metadata cannot be updated.
  }
  throw error;
}
