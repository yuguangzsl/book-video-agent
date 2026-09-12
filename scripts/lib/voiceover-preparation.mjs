import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./json.mjs";
import { writeFileAtomically } from "./filesystem.mjs";

export const DEFAULT_TTS_OPTIONS = Object.freeze({
  voice: "zh-CN-YunxiNeural",
  lang: "zh-CN",
  rate: "-8%",
  pitch: "-2Hz",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  timeout: 30000,
});
export const DEFAULT_TTS_CHUNK_CHARS = 40;
export const VOICEOVER_CHECKPOINT_FILENAME = "voiceover-checkpoints.json";
export const VOICEOVER_CHECKPOINT_SCHEMA_VERSION = 1;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function inputTextFromUnits(units) {
  return `${units.join("\n")}\n`;
}

function checkpointOptions(options = {}) {
  return {
    voice: String(options.voice || ""),
    lang: String(options.lang || ""),
    outputFormat: String(options.outputFormat || ""),
    rate: String(options.rate || ""),
    pitch: String(options.pitch || ""),
    timeout: Number(options.timeout),
    proxySha256: options.proxy ? sha256(String(options.proxy)) : null,
  };
}

function checkpointChunkFileNames(index) {
  const number = String(index + 1).padStart(2, "0");
  return {
    audio: `candidate/chunks/chunk-${number}.mp3`,
    boundaries: `candidate/chunks/chunk-${number}.edge-boundaries.json`,
  };
}

function resolveCheckpointFile(workspace, portablePath) {
  const resolvedWorkspace = path.resolve(workspace);
  const resolved = path.resolve(resolvedWorkspace, portablePath);
  const relative = path.relative(resolvedWorkspace, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Checkpoint file must stay inside its workspace: ${portablePath}`);
  }
  return resolved;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function getVoiceoverCheckpointManifestPath(workspace) {
  return path.join(workspace, VOICEOVER_CHECKPOINT_FILENAME);
}

export function getVoiceoverCheckpointChunkPaths(workspace, index) {
  const files = checkpointChunkFileNames(index);
  return {
    audioPath: resolveCheckpointFile(workspace, files.audio),
    boundariesPath: resolveCheckpointFile(workspace, files.boundaries),
    audioFile: files.audio,
    boundariesFile: files.boundaries,
  };
}

export function buildVoiceoverCheckpointManifest({ episode, scriptVersion, ttsUnits, ttsOptions, chunks, now = new Date() }) {
  const units = assertArray(ttsUnits, "TTS units").map((unit) => String(unit));
  const plan = assertArray(chunks, "TTS chunks").map((chunk, index) => {
    const chunkUnits = assertArray(chunk, `TTS chunk ${index + 1}`).map((unit) => String(unit));
    const text = chunkUnits.join(" ");
    return {
      index: index + 1,
      units: chunkUnits,
      text,
      sha256: sha256(text),
    };
  });
  const input = inputTextFromUnits(units);
  const createdAt = new Date(now).toISOString();
  return {
    schemaVersion: VOICEOVER_CHECKPOINT_SCHEMA_VERSION,
    kind: "body-voiceover-checkpoints",
    episode: String(episode),
    scriptVersion: String(scriptVersion),
    input: {
      units,
      text: input,
      sha256: sha256(input),
    },
    options: checkpointOptions(ttsOptions),
    chunkPlan: plan,
    completedChunks: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function writeVoiceoverCheckpointManifest(workspace, manifest) {
  const manifestPath = getVoiceoverCheckpointManifestPath(workspace);
  writeFileAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

export function validateVoiceoverCheckpointManifest(manifest, expected) {
  const actual = assertPlainObject(manifest, "Voiceover checkpoint manifest");
  const reference = assertPlainObject(expected, "Expected voiceover checkpoint manifest");
  if (actual.schemaVersion !== VOICEOVER_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(`Unsupported voiceover checkpoint schema: ${actual.schemaVersion}`);
  }
  if (actual.kind !== "body-voiceover-checkpoints") {
    throw new Error("Invalid voiceover checkpoint manifest kind");
  }
  for (const key of ["episode", "scriptVersion"]) {
    if (actual[key] !== reference[key]) {
      throw new Error(`Voiceover checkpoint ${key} does not match the requested episode`);
    }
  }
  for (const key of ["input", "options", "chunkPlan"]) {
    if (!sameJson(actual[key], reference[key])) {
      throw new Error(`Voiceover checkpoint ${key} does not match the current TTS inputs`);
    }
  }
  assertArray(actual.completedChunks, "Voiceover checkpoint completedChunks");
  return actual;
}

export function createOrResumeVoiceoverCheckpoint({
  workspace,
  resume = false,
  episode,
  scriptVersion,
  ttsUnits,
  ttsOptions,
  chunks,
}) {
  const expected = buildVoiceoverCheckpointManifest({
    episode,
    scriptVersion,
    ttsUnits,
    ttsOptions,
    chunks,
  });
  const manifestPath = getVoiceoverCheckpointManifestPath(workspace);
  if (!resume) {
    if (fs.existsSync(manifestPath)) {
      throw new Error(`Refusing to overwrite existing voiceover checkpoint manifest: ${manifestPath}`);
    }
    writeVoiceoverCheckpointManifest(workspace, expected);
    return expected;
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Resume workspace has no voiceover checkpoint manifest: ${manifestPath}`);
  }
  return validateVoiceoverCheckpointManifest(readJsonFile(manifestPath), expected);
}

export function assertVoiceoverResumeWorkspaceOwnership(metadata, episode, scriptVersion) {
  const details = metadata?.details || {};
  if (
    metadata?.kind !== "voiceover"
    || metadata?.owner !== "prepare-body-voiceover.mjs"
    || details.episode !== episode
    || details.scriptVersion !== scriptVersion
  ) {
    throw new Error(`Resume workspace does not belong to ${episode} ${scriptVersion}`);
  }
}

function checkpointEntryForIndex(manifest, index) {
  const expectedIndex = index + 1;
  const matches = manifest.completedChunks.filter((entry) => Number(entry?.index) === expectedIndex);
  if (matches.length > 1) throw new Error(`Voiceover checkpoint has duplicate chunk ${expectedIndex}`);
  return matches[0] || null;
}

export function validateVoiceoverCheckpointChunk({ workspace, manifest, index, expectedUnits, validateBoundaries }) {
  const entry = checkpointEntryForIndex(manifest, index);
  if (!entry) return null;
  const plan = manifest.chunkPlan[index];
  if (!plan || !sameJson(plan.units, expectedUnits) || plan.index !== index + 1) {
    throw new Error(`Voiceover checkpoint plan mismatch for chunk ${index + 1}`);
  }
  const paths = getVoiceoverCheckpointChunkPaths(workspace, index);
  if (
    entry?.audio?.file !== paths.audioFile
    || entry?.boundaries?.file !== paths.boundariesFile
    || !/^[a-f0-9]{64}$/u.test(String(entry?.audio?.sha256 || ""))
    || !/^[a-f0-9]{64}$/u.test(String(entry?.boundaries?.sha256 || ""))
  ) {
    throw new Error(`Voiceover checkpoint files are invalid for chunk ${index + 1}`);
  }
  if (!fs.existsSync(paths.audioPath) || fs.statSync(paths.audioPath).size <= 0) {
    throw new Error(`Voiceover checkpoint audio is missing for chunk ${index + 1}`);
  }
  if (!fs.existsSync(paths.boundariesPath)) {
    throw new Error(`Voiceover checkpoint boundaries are missing for chunk ${index + 1}`);
  }
  if (hashFile(paths.audioPath) !== entry.audio.sha256) {
    throw new Error(`Voiceover checkpoint audio hash mismatch for chunk ${index + 1}`);
  }
  if (hashFile(paths.boundariesPath) !== entry.boundaries.sha256) {
    throw new Error(`Voiceover checkpoint boundaries hash mismatch for chunk ${index + 1}`);
  }
  const boundaries = readJsonFile(paths.boundariesPath);
  assertArray(boundaries, `Voiceover checkpoint boundaries for chunk ${index + 1}`);
  validateBoundaries(boundaries, expectedUnits);
  return { ...paths, boundaries };
}

export function recordVoiceoverCheckpointChunk({ workspace, manifest, index, expectedUnits, validateBoundaries }) {
  const plan = manifest.chunkPlan[index];
  if (!plan || !sameJson(plan.units, expectedUnits) || plan.index !== index + 1) {
    throw new Error(`Voiceover checkpoint plan mismatch for chunk ${index + 1}`);
  }
  const paths = getVoiceoverCheckpointChunkPaths(workspace, index);
  if (!fs.existsSync(paths.audioPath) || fs.statSync(paths.audioPath).size <= 0) {
    throw new Error(`Cannot checkpoint missing audio for chunk ${index + 1}`);
  }
  if (!fs.existsSync(paths.boundariesPath)) {
    throw new Error(`Cannot checkpoint missing native boundaries for chunk ${index + 1}`);
  }
  const boundaries = readJsonFile(paths.boundariesPath);
  assertArray(boundaries, `Voiceover checkpoint boundaries for chunk ${index + 1}`);
  validateBoundaries(boundaries, expectedUnits);
  const entry = {
    index: index + 1,
    audio: { file: paths.audioFile, sha256: hashFile(paths.audioPath) },
    boundaries: { file: paths.boundariesFile, sha256: hashFile(paths.boundariesPath) },
  };
  manifest.completedChunks = manifest.completedChunks.filter((candidate) => Number(candidate?.index) !== index + 1);
  manifest.completedChunks.push(entry);
  manifest.completedChunks.sort((left, right) => Number(left.index) - Number(right.index));
  manifest.updatedAt = new Date().toISOString();
  writeVoiceoverCheckpointManifest(workspace, manifest);
  return entry;
}

export async function callEdgeTtsWithSocketCleanup(tts, text) {
  const connect = tts?._connectWebSocket;
  if (typeof connect !== "function") return tts.call(text);
  let socket = null;
  tts._connectWebSocket = async function trackedConnect(...args) {
    socket = await connect.apply(this, args);
    return socket;
  };
  try {
    return await tts.call(text);
  } finally {
    tts._connectWebSocket = connect;
    try {
      if (socket && typeof socket.terminate === "function") socket.terminate();
      else if (socket && typeof socket.close === "function") socket.close();
    } catch {
      // A completed Edge TTS call may already have closed its socket.
    }
  }
}

export function ensureTtsSentenceTerminator(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("TTS unit must not be empty");
  if (/[。！？!?]$/u.test(text)) return text;
  return `${text.replace(/[，、；：,;:]+$/u, "")}。`;
}

export function buildBodyTtsUnits(displayTitle, rows) {
  const title = String(displayTitle || "").trim().replace(/^《|》$/gu, "");
  if (!title) throw new Error("Display title is required for TTS input");
  return [
    ensureTtsSentenceTerminator(`《${title}》`),
    ...rows.map((row) => ensureTtsSentenceTerminator(row.text)),
  ];
}

export function buildBodyTtsChunks(units, maxChars = DEFAULT_TTS_CHUNK_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error(`Invalid TTS chunk size: ${maxChars}`);
  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const value of units) {
    const unit = String(value || "").trim();
    if (!unit) throw new Error("TTS chunk input must not contain empty units");
    const separatorChars = current.length ? 1 : 0;
    if (current.length && currentChars + separatorChars + unit.length > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(unit);
    currentChars += (current.length > 1 ? 1 : 0) + unit.length;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

export function edgeSubtitleOutputPath(audioPath) {
  return `${audioPath}.json`;
}
