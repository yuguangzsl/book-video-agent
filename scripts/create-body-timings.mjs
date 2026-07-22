#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  assertTtsUnitsMatchScript,
  buildCaptionTimings,
  buildEdgeSubtitleSegments,
  buildSpeechSegments,
  coalesceSpeechSegments,
  normalizeTimingOptions,
  parseSilenceEvents,
} from "./lib/body-timings.mjs";
import { toPortableProjectPath } from "./lib/artifact-paths.mjs";
import { runCommandSync } from "./lib/command.mjs";
import { writeFileAtomically } from "./lib/filesystem.mjs";
import { readJsonFile } from "./lib/json.mjs";
import { sha256File } from "./lib/render-manifest.mjs";
import { readScriptRows } from "./lib/script-csv.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";

const ROOT = process.cwd();
const MODEL_PATH = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
const [episodeName, ...cliArgs] = process.argv.slice(2);
const requestedVersion = cliArgs[0] && !cliArgs[0].startsWith("--") ? cliArgs.shift() : undefined;
const rest = cliArgs;

function readOptions(values) {
  const positional = [];
  const options = { skipLeading: 1, noise: "-35dB", silenceDuration: "0.18" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--skip-leading" || value === "--noise" || value === "--silence-duration" || value === "--edge-subtitles") {
      options[{ "--skip-leading": "skipLeading", "--noise": "noise", "--silence-duration": "silenceDuration", "--edge-subtitles": "edgeSubtitles" }[value]] = values[++index];
    } else if (value.startsWith("--skip-leading=")) options.skipLeading = value.split("=", 2)[1];
    else if (value.startsWith("--noise=")) options.noise = value.split("=", 2)[1];
    else if (value.startsWith("--silence-duration=")) options.silenceDuration = value.split("=", 2)[1];
    else if (value.startsWith("--edge-subtitles=")) options.edgeSubtitles = value.slice("--edge-subtitles=".length);
    else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  if (positional.length > 1) throw new Error(`Unexpected positional argument: ${positional[1]}`);
  return { positional, options: normalizeTimingOptions(options) };
}

function run(command, args, options = {}) {
  return runCommandSync(command, args, { cwd: ROOT, ...options });
}

function usage() {
  console.error("Usage: node scripts/create-body-timings.mjs <episode-name> [script-version] [voiceover-path] [options]");
  console.error("Options: --skip-leading 1 --noise -35dB --silence-duration 0.18 --edge-subtitles <json>");
}

if (!episodeName) {
  usage();
  process.exit(1);
}

const { positional, options } = readOptions(rest);
const episodeDir = path.join(ROOT, "episodes", episodeName);
const scriptVersion = resolveScriptVersion(episodeDir, requestedVersion);
const audioDir = path.join(episodeDir, "audio");
const scriptPath = path.join(episodeDir, "script.csv");
const voicePath = path.resolve(ROOT, positional[0] || path.join("episodes", episodeName, "audio", "body-voiceover.mp3"));
const asrDir = path.join(audioDir, "asr");
const asrBase = path.join(asrDir, "body");
const timingsPath = path.join(audioDir, "body-timings.json");

if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
if (!fs.existsSync(scriptPath)) throw new Error(`Missing script.csv: ${scriptPath}`);
if (!fs.existsSync(voicePath)) throw new Error(`Voiceover not found: ${voicePath}`);
if (!options.edgeSubtitles && !fs.existsSync(MODEL_PATH)) {
  throw new Error(`Missing Whisper model: ${MODEL_PATH}. Run node scripts/download-whisper-model.mjs first.`);
}

const rows = readScriptRows(scriptPath, scriptVersion);
if (!rows.length) throw new Error(`No script rows found for version ${scriptVersion}`);
const scriptValidation = validateBodyScript(rows);
if (scriptValidation.errors.length) throw new Error(scriptValidation.errors.join("；"));

const durationResult = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", voicePath]);
const duration = Number(durationResult.stdout.trim());
if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid voiceover duration: ${duration}`);

const skipLeading = options.skipLeading;
let captions;
let timingSource;
let timingDetails;

if (options.edgeSubtitles) {
  const edgeSubtitlesPath = path.resolve(ROOT, options.edgeSubtitles);
  if (!fs.existsSync(edgeSubtitlesPath)) throw new Error(`Edge TTS subtitles not found: ${edgeSubtitlesPath}`);
  const edgeItems = readJsonFile(edgeSubtitlesPath);
  const inferredTtsInputPath = edgeSubtitlesPath.replace(/\.edge-timings\.json$/u, "-input.txt");
  const ttsInputPath = fs.existsSync(inferredTtsInputPath)
    ? inferredTtsInputPath
    : path.join(audioDir, "body-voiceover-input.txt");
  const ttsUnits = fs.existsSync(ttsInputPath)
    ? fs.readFileSync(ttsInputPath, "utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    : null;
  if (!ttsUnits) {
    throw new Error(`TTS input copy not found: ${ttsInputPath}. It is required with --edge-subtitles.`);
  }
  if (ttsUnits && ttsUnits.length !== rows.length + skipLeading) {
    throw new Error(
      `TTS input unit count mismatch: found ${ttsUnits.length}, need ${rows.length + skipLeading} `
      + `(including skip-leading=${skipLeading}).`,
    );
  }
  if (ttsUnits) assertTtsUnitsMatchScript(ttsUnits, rows.map((row) => row.text), skipLeading);
  const speechSegments = buildEdgeSubtitleSegments(edgeItems, ttsUnits);
  captions = buildCaptionTimings(rows.map((row) => row.order), speechSegments, skipLeading);
  timingSource = "node-edge-tts word boundaries; script.csv remains subtitle truth";
  timingDetails = {
    edgeSubtitles: toPortableProjectPath(ROOT, edgeSubtitlesPath, "edge subtitles"),
    edgeSubtitlesSha256: sha256File(edgeSubtitlesPath),
    ttsInput: toPortableProjectPath(ROOT, ttsInputPath, "TTS input"),
    ttsInputSha256: sha256File(ttsInputPath),
  };
} else {
  fs.mkdirSync(asrDir, { recursive: true });
  run("whisper-cli", ["-ng", "-m", MODEL_PATH, "-l", "zh", "-oj", "-otxt", "-of", asrBase, voicePath], { stdio: "inherit" });
  const silenceResult = run(
    "ffmpeg",
    ["-hide_banner", "-i", voicePath, "-af", `silencedetect=noise=${options.noise}:d=${options.silenceDuration}`, "-f", "null", "-"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const events = parseSilenceEvents(`${silenceResult.stdout}\n${silenceResult.stderr}`);
  const speechSegments = buildSpeechSegments(duration, events);
  const normalizedSegments = coalesceSpeechSegments(speechSegments, rows.length + skipLeading);
  captions = buildCaptionTimings(rows.map((row) => row.order), normalizedSegments, skipLeading);
  timingSource = "whisper-cli + ffmpeg silencedetect; script.csv remains subtitle truth";
  timingDetails = {
    asr: toPortableProjectPath(ROOT, `${asrBase}.json`, "ASR output"),
    asrSha256: sha256File(`${asrBase}.json`),
    silence: { noise: options.noise, duration: options.silenceDuration },
  };
}

writeFileAtomically(
  timingsPath,
  `${JSON.stringify({
    schemaVersion: 1,
    scriptVersion,
    duration: Number(duration.toFixed(2)),
    source: timingSource,
    sourceKind: options.edgeSubtitles ? "edge-tts" : "speech-pause",
    audio: toPortableProjectPath(ROOT, voicePath, "voiceover"),
    audioSha256: sha256File(voicePath),
    skipLeadingSegments: skipLeading,
    ...timingDetails,
    captions,
  }, null, 2)}\n`,
);

if (!options.edgeSubtitles) console.log(`ASR JSON: ${path.relative(ROOT, `${asrBase}.json`)}`);
console.log(`Body timings: ${path.relative(ROOT, timingsPath)}`);
