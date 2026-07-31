import fs from "node:fs";
import path from "node:path";
import { readCsvFile } from "./csv.mjs";

const MEDIA_EXTENSIONS = new Set([".aac", ".flac", ".jpeg", ".jpg", ".m4a", ".mp3", ".mp4", ".ogg", ".png", ".wav", ".webp"]);
const REQUIRED_HEADERS = [
  "path",
  "generation_date",
  "generation_tool",
  "prompt_id",
  "human_review",
  "redistribution_decision",
];

function portablePath(value) {
  return value.split(path.sep).join("/");
}

function collectMediaFiles(root, directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMediaFiles(root, entryPath));
    else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(portablePath(path.relative(root, entryPath)));
    }
  }
  return files;
}

function canonicalProvenancePath(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (normalized.startsWith("assets/") || normalized.startsWith("templates/")) return normalized;
  return `templates/shared-video-template/${normalized}`;
}

export function validateAssetProvenance(root) {
  const provenancePath = path.join(root, "templates", "shared-video-template", "ASSET_PROVENANCE.csv");
  const { rows } = readCsvFile(provenancePath, { requiredHeaders: REQUIRED_HEADERS });
  const mediaFiles = [
    ...collectMediaFiles(root, path.join(root, "assets", "bgm")),
    ...collectMediaFiles(root, path.join(root, "assets", "sfx")),
    ...collectMediaFiles(root, path.join(root, "assets", "template-audio")),
    ...collectMediaFiles(root, path.join(root, "templates", "shared-video-template", "intro", "media")),
  ].sort();
  const byPath = new Map();
  for (const row of rows) {
    const file = canonicalProvenancePath(row.path);
    if (byPath.has(file)) throw new Error(`${provenancePath}: duplicate provenance row for ${file}`);
    for (const header of REQUIRED_HEADERS) {
      if (!String(row[header] || "").trim()) throw new Error(`${provenancePath}: ${file} has empty ${header}`);
    }
    if (row.human_review !== "reviewed") throw new Error(`${provenancePath}: ${file} must be human reviewed`);
    if (/pending|unknown|unconfirmed|denied/iu.test(row.redistribution_decision)) {
      throw new Error(`${provenancePath}: ${file} has no confirmed redistribution decision`);
    }
    byPath.set(file, row);
  }
  for (const file of mediaFiles) {
    if (!byPath.has(file)) throw new Error(`${provenancePath}: missing provenance row for ${file}`);
  }
  for (const file of byPath.keys()) {
    if (!mediaFiles.includes(file)) throw new Error(`${provenancePath}: provenance path does not exist: ${file}`);
  }
  return { provenancePath, mediaCount: mediaFiles.length, mediaFiles };
}
