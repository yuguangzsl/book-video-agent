#!/usr/bin/env node

import { validateCompletedEpisode } from "./lib/episode-checks.mjs";
import { prepareEpisodeQa, episodeQaDraftPath } from "./lib/episode-qa.mjs";
import { sha256File } from "./lib/render-manifest.mjs";

const [episodeName, requestedVersion = "", reworkText = "0"] = process.argv.slice(2);
if (!episodeName) {
  console.error("Usage: node scripts/prepare-episode-qa.mjs <episode-name> [script-version] [rework-count]");
  process.exit(1);
}

const completed = validateCompletedEpisode(process.cwd(), episodeName, requestedVersion, {
  requirePublish: true,
  validateQueue: false,
});
const draft = prepareEpisodeQa(process.cwd(), completed, { reworkCount: Number(reworkText) });
const draftPath = episodeQaDraftPath(completed);
process.stdout.write(`${JSON.stringify({ draftPath, draftSha256: sha256File(draftPath), ...draft }, null, 2)}\n`);
