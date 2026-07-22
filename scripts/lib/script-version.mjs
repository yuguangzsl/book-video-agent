import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./json.mjs";
import { readScriptRows } from "./script-csv.mjs";

export function resolveScriptVersion(episodeDir, requestedVersion = "") {
  if (requestedVersion) return requestedVersion;

  const briefPath = path.join(episodeDir, "brief.json");
  if (fs.existsSync(briefPath)) {
    const brief = readJsonFile(briefPath);
    if (brief.scriptVersion) return String(brief.scriptVersion);
  }

  const scriptPath = path.join(episodeDir, "script.csv");
  if (fs.existsSync(scriptPath)) {
    const versions = new Set(readScriptRows(scriptPath).map((row) => row.version).filter(Boolean));
    if (versions.size === 1) return [...versions][0];
    if (versions.size > 1) {
      throw new Error(`Script version is ambiguous; specify one of: ${[...versions].join(", ")}`);
    }
  }

  throw new Error(`Could not resolve script version from brief.json or script.csv in ${episodeDir}`);
}
