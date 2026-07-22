#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
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
  removeTempWorkspace,
  updateTempWorkspace,
} from "./lib/temp-lifecycle.mjs";
import {
  DEFAULT_TTS_OPTIONS,
  buildBodyTtsUnits,
  edgeSubtitleOutputPath,
} from "./lib/voiceover-preparation.mjs";

const ROOT = process.cwd();
const NODE_EDGE_TTS_PACKAGE = "node-edge-tts@1.2.10";
const [episodeName, ...cliArgs] = process.argv.slice(2);
const requestedVersion = cliArgs[0] && !cliArgs[0].startsWith("--") ? cliArgs.shift() : undefined;
const optionArgs = cliArgs;

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

if (!episodeName) {
  console.error("Usage: node scripts/prepare-body-voiceover.mjs <episode-name> [script-version] [options]");
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
const displayTitle = brief.display_title || brief.displayTitle || brief.title;
const ttsUnits = buildBodyTtsUnits(displayTitle, rows);

const workspace = createTempWorkspace(ROOT, {
  kind: "voiceover",
  label: slugifyEpisodeName(episodeName),
  owner: "prepare-body-voiceover.mjs",
  retentionHours: TEMP_RETENTION_HOURS.active,
  details: { episode: episodeName, scriptVersion },
});
const candidateDir = path.join(workspace, "candidate");
const backupDir = path.join(workspace, "backup");
const candidateAudio = path.join(candidateDir, "body-voiceover.mp3");
const generatedSubtitles = edgeSubtitleOutputPath(candidateAudio);
const candidateEdgeSubtitles = path.join(candidateDir, "body-voiceover.edge-timings.json");
const candidateInput = path.join(candidateDir, "body-voiceover-input.txt");
const audioDir = path.join(episodeDir, "audio");
const audioPath = path.join(audioDir, "body-voiceover.mp3");
const edgeSubtitlesPath = path.join(audioDir, "body-voiceover.edge-timings.json");
const inputPath = path.join(audioDir, "body-voiceover-input.txt");
const timingsPath = path.join(audioDir, "body-timings.json");
const timingBackupPath = path.join(workspace, "previous-body-timings.json");
const hadTimingFile = fs.existsSync(timingsPath);

try {
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.writeFileSync(candidateInput, `${ttsUnits.join("\n")}\n`);
  const args = [
    "--yes",
    NODE_EDGE_TTS_PACKAGE,
    "-t", ttsUnits.join("\n"),
    "-f", candidateAudio,
    "-v", ttsOptions.voice,
    "-l", ttsOptions.lang,
    "-o", ttsOptions.outputFormat,
    `--rate=${ttsOptions.rate}`,
    `--pitch=${ttsOptions.pitch}`,
    `--timeout=${ttsOptions.timeout}`,
    "--saveSubtitles",
  ];
  if (ttsOptions.proxy) args.push("--proxy", ttsOptions.proxy);
  run("npx", args);
  if (!fs.existsSync(candidateAudio)) throw new Error(`node-edge-tts did not create audio: ${candidateAudio}`);
  if (!fs.existsSync(generatedSubtitles)) throw new Error(`node-edge-tts did not create subtitles: ${generatedSubtitles}`);
  fs.renameSync(generatedSubtitles, candidateEdgeSubtitles);
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
    removeTempWorkspace(ROOT, workspace);
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
}
