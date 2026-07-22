#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readScriptRows } from "./lib/script-csv.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";

const ROOT = process.cwd();
const [episodeName, requestedVersion] = process.argv.slice(2);

if (!episodeName) {
  console.error("Usage: node scripts/validate-script.mjs <episode-name> [script-version]");
  process.exit(1);
}

const episodeDir = path.join(ROOT, "episodes", episodeName);
const scriptPath = path.join(episodeDir, "script.csv");
if (!fs.existsSync(scriptPath)) throw new Error(`Missing script.csv: ${scriptPath}`);
const version = resolveScriptVersion(episodeDir, requestedVersion);
const rows = readScriptRows(scriptPath, version);

const result = { episode: episodeName, scriptVersion: version, ...validateBodyScript(rows) };
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) {
  console.error(result.errors.join("；"));
  process.exit(1);
}
