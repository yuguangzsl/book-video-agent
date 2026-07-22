#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  formatCompletedEpisodeDelivery,
  validateCompletedEpisode,
  validateEpisodeForRender,
} from "./lib/episode-checks.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const all = args.includes("--all");
const preRender = args.includes("--pre-render");
const delivery = args.includes("--delivery");
const positional = args.filter((arg) => !arg.startsWith("--"));

if ((!all && positional.length === 0) || (all && delivery)) {
  console.error("Usage: node scripts/check-episode.mjs <episode-name> [script-version] [--pre-render|--delivery]");
  console.error("       node scripts/check-episode.mjs --all");
  process.exit(1);
}

const episodeNames = all
  ? fs.readdirSync(path.join(ROOT, "episodes"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
  : [positional[0]];
const requestedVersion = all ? "" : positional[1] || "";
const failures = [];

for (const episodeName of episodeNames) {
  try {
    const result = preRender
      ? validateEpisodeForRender(ROOT, episodeName, requestedVersion)
      : validateCompletedEpisode(ROOT, episodeName, requestedVersion, { requirePublish: delivery });
    if (delivery) {
      console.log(formatCompletedEpisodeDelivery(result));
    } else {
      console.log(`OK ${episodeName} (${result.scriptVersion})`);
      for (const warning of result.warnings) console.warn(`WARN ${episodeName}: ${warning}`);
    }
  } catch (error) {
    failures.push({ episodeName, message: error.message });
    console.error(`FAIL ${episodeName}: ${error.message}`);
  }
}

if (failures.length) process.exit(1);
