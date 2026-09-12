#!/usr/bin/env node

import path from "node:path";
import { validateCompletedEpisode } from "./lib/episode-checks.mjs";
import { completeEpisodeQa } from "./lib/episode-qa.mjs";
import { readJsonFile } from "./lib/json.mjs";

const [episodeName, reviewPath, requestedVersion = ""] = process.argv.slice(2);
if (!episodeName || !reviewPath) {
  console.error("Usage: node scripts/complete-episode-qa.mjs <episode-name> <review.json> [script-version]");
  process.exit(1);
}

const completed = validateCompletedEpisode(process.cwd(), episodeName, requestedVersion, {
  requirePublish: true,
  validateQueue: false,
});
const result = completeEpisodeQa(process.cwd(), completed, readJsonFile(path.resolve(reviewPath)));
process.stdout.write(`${JSON.stringify({ passed: true, qaPath: result.filePath, renderSha256: result.qa.bindings.renderSha256 }, null, 2)}\n`);
