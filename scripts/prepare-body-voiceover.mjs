#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { EdgeTTS } from "@seepine/edge-tts";
import { buildEdgeSubtitleSegments } from "./lib/body-timings.mjs";
import { runCommandSync } from "./lib/command.mjs";
import { validateBodyTimingArtifact } from "./lib/episode-checks.mjs";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { replaceFilesWithRollback } from "./lib/file-transaction.mjs";
import { writeFileAtomically } from "./lib/filesystem.mjs";
import { readJsonFile } from "./lib/json.mjs";
import { readScriptRows } from "./lib/script-csv.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import {
  TEMP_RETENTION_HOURS,
  createTempWorkspace,
  readManagedTempWorkspaceMetadata,
  removeTempWorkspace,
  updateTempWorkspace,
} from "./lib/temp-lifecycle.mjs";
import {
  DEFAULT_TTS_OPTIONS,
  assertVoiceoverResumeWorkspaceOwnership,
  buildBodyTtsChunks,
  buildBodyTtsUnits,
  callEdgeTtsWithSocketCleanup,
  createOrResumeVoiceoverCheckpoint,
  getVoiceoverCheckpointChunkPaths,
  recordVoiceoverCheckpointChunk,
  validateVoiceoverCheckpointChunk,
} from "./lib/voiceover-preparation.mjs";
import { resolveBriefDisplayTitle } from "./lib/brief-display-title.mjs";
import { createTtsPacing } from "./lib/tts-pacing.mjs";

const ROOT = process.cwd();
const [episodeName, ...rawCliArgs] = process.argv.slice(2);

function parseCliArguments(args) {
  const values = [...args];
  const requestedVersion = values[0] && !values[0].startsWith("--") ? values.shift() : undefined;
  const optionArgs = [];
  let resumeWorkspace;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--resume") {
      if (resumeWorkspace !== undefined) throw new Error("--resume may only be specified once");
      resumeWorkspace = values[++index];
      if (!resumeWorkspace) throw new Error("Missing value for --resume");
      continue;
    }
    if (argument.startsWith("--resume=")) {
      if (resumeWorkspace !== undefined) throw new Error("--resume may only be specified once");
      resumeWorkspace = argument.slice("--resume=".length);
      if (!resumeWorkspace) throw new Error("Missing value for --resume");
      continue;
    }
    optionArgs.push(argument);
  }
  return { requestedVersion, optionArgs, resumeWorkspace };
}

const { requestedVersion, optionArgs, resumeWorkspace } = parseCliArguments(rawCliArgs);

function readOptions(values) {
  const options = { ...DEFAULT_TTS_OPTIONS };
  const keys = new Map([
    ["--voice", "voice"],
    ["--lang", "lang"],
    ["--rate", "rate"],
    ["--pitch", "pitch"],
    ["--output-format", "outputFormat"],
    ["--timeout", "timeout"],
    ["--proxy", "proxy"],
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    const [flag, inlineValue] = argument.split("=", 2);
    const key = keys.get(flag);
    if (!key) throw new Error(`Unknown option: ${argument}`);
    const value = inlineValue ?? values[++index];
    if (value === undefined || value === "") throw new Error(`Missing value for ${flag}`);
    options[key] = key === "timeout" ? Number(value) : value;
  }
  if (!Number.isInteger(options.timeout) || options.timeout <= 0) throw new Error(`Invalid --timeout: ${options.timeout}`);
  return options;
}

function run(command, args, options = {}) {
  return runCommandSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: options.stdio || "inherit",
  });
}

function restoreTimingFile(timingsPath, backupPath, hadTimingFile) {
  if (hadTimingFile) {
    writeFileAtomically(timingsPath, fs.readFileSync(backupPath));
  } else if (fs.existsSync(timingsPath)) {
    fs.rmSync(timingsPath, { force: true });
  }
}

function probeAudioDuration(audioPath) {
  const result = run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ], { stdio: "pipe" });
  const duration = Number(String(result.stdout || "").trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid audio duration: ${audioPath}`);
  return duration;
}

function formatConcatFilePath(filePath) {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  if (normalized.includes("'")) throw new Error(`Unsupported apostrophe in TTS chunk path: ${filePath}`);
  return `file '${normalized}'`;
}

if (!episodeName) {
  console.error("Usage: node scripts/prepare-body-voiceover.mjs <episode-name> [script-version] [--resume <managed-workspace>] [options]");
  process.exit(1);
}

const ttsOptions = readOptions(optionArgs);
const episodeDir = path.join(ROOT, "episodes", episodeName);
const briefPath = path.join(episodeDir, "brief.json");
const scriptPath = path.join(episodeDir, "script.csv");
if (!fs.existsSync(briefPath)) throw new Error(`Missing brief.json: ${briefPath}`);
if (!fs.existsSync(scriptPath)) throw new Error(`Missing script.csv: ${scriptPath}`);
const brief = readJsonFile(briefPath);
const scriptVersion = resolveScriptVersion(episodeDir, requestedVersion);
const rows = readScriptRows(scriptPath, scriptVersion);
const scriptValidation = validateBodyScript(rows);
if (scriptValidation.errors.length) throw new Error(scriptValidation.errors.join("；"));
const displayTitle = resolveBriefDisplayTitle(brief, episodeName);
const ttsUnits = buildBodyTtsUnits(displayTitle, rows);
const chunks = buildBodyTtsChunks(ttsUnits);
const isResume = Boolean(resumeWorkspace);
const workspace = isResume
  ? path.resolve(ROOT, resumeWorkspace)
  : createTempWorkspace(ROOT, {
    kind: "voiceover",
    label: slugifyEpisodeName(episodeName),
    owner: "prepare-body-voiceover.mjs",
    retentionHours: TEMP_RETENTION_HOURS.active,
    details: { episode: episodeName, scriptVersion },
  });

if (isResume) {
  const metadata = readManagedTempWorkspaceMetadata(ROOT, workspace);
  assertVoiceoverResumeWorkspaceOwnership(metadata, episodeName, scriptVersion);
}

const candidateDir = path.join(workspace, "candidate");
const backupDir = path.join(workspace, "backup");
const candidateAudio = path.join(candidateDir, "body-voiceover.mp3");
const candidateEdgeSubtitles = path.join(candidateDir, "body-voiceover.edge-timings.json");
const candidateInput = path.join(candidateDir, "body-voiceover-input.txt");
const concatListPath = path.join(candidateDir, "body-voiceover-concat.txt");
const audioDir = path.join(episodeDir, "audio");
const audioPath = path.join(audioDir, "body-voiceover.mp3");
const edgeSubtitlesPath = path.join(audioDir, "body-voiceover.edge-timings.json");
const inputPath = path.join(audioDir, "body-voiceover-input.txt");
const timingsPath = path.join(audioDir, "body-timings.json");
const timingBackupPath = path.join(workspace, "previous-body-timings.json");
const hadTimingFile = fs.existsSync(timingsPath);
const ttsPacing = createTtsPacing();
let voiceoverStatus = "failed";

try {
  fs.mkdirSync(candidateDir, { recursive: true });
  const checkpointManifest = createOrResumeVoiceoverCheckpoint({
    workspace,
    resume: isResume,
    episode: episodeName,
    scriptVersion,
    ttsUnits,
    ttsOptions,
    chunks,
  });
  writeFileAtomically(candidateInput, `${ttsUnits.join("\n")}\n`);
  const tts = new EdgeTTS({
    voice: ttsOptions.voice,
    lang: ttsOptions.lang,
    outputFormat: ttsOptions.outputFormat,
    rate: ttsOptions.rate,
    pitch: ttsOptions.pitch,
    timeout: ttsOptions.timeout,
    proxy: ttsOptions.proxy || undefined,
  });
  const chunkPaths = [];
  const combinedSubtitles = [];
  let elapsedMs = 0;
  for (const [index, chunk] of chunks.entries()) {
    let checkpoint = null;
    try {
      checkpoint = validateVoiceoverCheckpointChunk({
        workspace,
        manifest: checkpointManifest,
        index,
        expectedUnits: chunk,
        validateBoundaries: buildEdgeSubtitleSegments,
      });
    } catch (checkpointError) {
      console.warn(`TTS checkpoint chunk ${index + 1} cannot be reused; synthesizing again: ${String(checkpointError.message || checkpointError)}`);
    }

    let chunkPath;
    let nativeSubtitles;
    if (checkpoint) {
      chunkPath = checkpoint.audioPath;
      nativeSubtitles = checkpoint.boundaries;
      ttsPacing.reuseChunk(index);
      console.log(`Reusing verified TTS checkpoint chunk ${index + 1}: ${chunkPath}`);
    } else {
      const generated = await ttsPacing.synthesizeChunk(index, () => callEdgeTtsWithSocketCleanup(tts, chunk.join(" ")));
      if (!generated?.data || Number(generated.data.length) <= 0) {
        throw new Error(`Edge TTS returned no audio for chunk ${index + 1}`);
      }
      if (!Array.isArray(generated.subtitles)) {
        throw new Error(`Edge TTS returned no native boundaries for chunk ${index + 1}`);
      }
      buildEdgeSubtitleSegments(generated.subtitles, chunk);
      const checkpointPaths = getVoiceoverCheckpointChunkPaths(workspace, index);
      writeFileAtomically(checkpointPaths.audioPath, generated.data);
      writeFileAtomically(checkpointPaths.boundariesPath, `${JSON.stringify(generated.subtitles, null, 2)}\n`);
      recordVoiceoverCheckpointChunk({
        workspace,
        manifest: checkpointManifest,
        index,
        expectedUnits: chunk,
        validateBoundaries: buildEdgeSubtitleSegments,
      });
      chunkPath = checkpointPaths.audioPath;
      nativeSubtitles = generated.subtitles;
    }

    for (const item of nativeSubtitles) {
      combinedSubtitles.push({
        ...item,
        start: Number(item.start) + elapsedMs,
        end: Number(item.end) + elapsedMs,
      });
    }
    elapsedMs += probeAudioDuration(chunkPath) * 1000;
    chunkPaths.push(chunkPath);
  }
  fs.writeFileSync(concatListPath, `${chunkPaths.map(formatConcatFilePath).join("\n")}\n`);
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatListPath,
    "-c", "copy", candidateAudio,
  ]);
  writeFileAtomically(candidateEdgeSubtitles, `${JSON.stringify(combinedSubtitles, null, 2)}\n`);
  if (!fs.existsSync(candidateAudio)) throw new Error(`node-edge-tts did not create audio: ${candidateAudio}`);
  if (!fs.existsSync(candidateEdgeSubtitles)) throw new Error(`node-edge-tts did not create subtitles: ${candidateEdgeSubtitles}`);
  const edgeItems = readJsonFile(candidateEdgeSubtitles);
  buildEdgeSubtitleSegments(edgeItems, ttsUnits);

  if (hadTimingFile) fs.copyFileSync(timingsPath, timingBackupPath);
  try {
    replaceFilesWithRollback([
      { source: candidateAudio, destination: audioPath },
      { source: candidateEdgeSubtitles, destination: edgeSubtitlesPath },
      { source: candidateInput, destination: inputPath },
    ], backupDir, () => {
      run(process.execPath, [
        path.join(ROOT, "scripts", "create-body-timings.mjs"),
        episodeName,
        scriptVersion,
        audioPath,
        "--edge-subtitles",
        edgeSubtitlesPath,
      ]);
      validateBodyTimingArtifact(ROOT, timingsPath, scriptVersion, rows);
    });
  } catch (error) {
    restoreTimingFile(timingsPath, timingBackupPath, hadTimingFile);
    throw error;
  }

  try {
    if (isResume) {
      updateTempWorkspace(ROOT, workspace, {
        status: "completed",
        retentionHours: TEMP_RETENTION_HOURS.preview,
        details: { stage: "voiceover", checkpoint: "resumed-and-completed" },
      });
    } else {
      removeTempWorkspace(ROOT, workspace);
    }
  } catch (cleanupError) {
    try {
      updateTempWorkspace(ROOT, workspace, {
        status: "cleanup-pending",
        retentionHours: TEMP_RETENTION_HOURS.active,
        details: { stage: "cleanup", failure: String(cleanupError.message || cleanupError).slice(0, 500) },
      });
    } catch {
      // The active voiceover files are already validated; cleanup remains best-effort.
    }
    console.warn(`Voiceover succeeded, but temporary workspace cleanup is pending: ${workspace}`);
  }
  console.log(audioPath);
  console.log(timingsPath);
  voiceoverStatus = "succeeded";
} catch (error) {
  try {
    updateTempWorkspace(ROOT, workspace, {
      status: "failed",
      retentionHours: TEMP_RETENTION_HOURS.failed,
      details: { stage: "voiceover", failure: String(error.message || error).slice(0, 500) },
    });
    console.error(`Temporary voiceover workspace retained for diagnostics: ${workspace}`);
  } catch {
    // Preserve the original voiceover error.
  }
  throw error;
} finally {
  ttsPacing.finish(voiceoverStatus);
}
