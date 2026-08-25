#!/usr/bin/env node

import {
  formatCompletedEpisodeDelivery,
  validateCompletedEpisode,
} from "./lib/episode-checks.mjs";
import { recordGeneratedTitle } from "./lib/generated-title-index.mjs";
import { upsertCompletedEpisodeIntoPublishQueue } from "./lib/publish-queue.mjs";
import { createReleasePackage } from "./lib/release-package.mjs";
import {
  assertEpisodeCanFinalizeForReplenishment,
  assertEpisodeCanRenderForReplenishment,
  markReplenishmentEpisodePublishable,
} from "./lib/replenishment-batch.mjs";

const ROOT = process.cwd();
const [episodeName, requestedVersion = ""] = process.argv.slice(2);

if (!episodeName) {
  console.error("Usage: node scripts/finalize-episode.mjs <episode-name> [script-version]");
  process.exit(1);
}

const replenishmentBatch = assertEpisodeCanRenderForReplenishment(ROOT, episodeName);
assertEpisodeCanFinalizeForReplenishment(ROOT, episodeName, { batch: replenishmentBatch });
const completed = validateCompletedEpisode(ROOT, episodeName, requestedVersion, {
  requirePublish: true,
  validateQueue: false,
});
const release = createReleasePackage(ROOT, completed);
recordGeneratedTitle(ROOT, completed.episodeName);
upsertCompletedEpisodeIntoPublishQueue(ROOT, { ...completed, release });
const verified = validateCompletedEpisode(ROOT, episodeName, requestedVersion, {
  requirePublish: true,
  requireQueue: true,
});
const delivery = formatCompletedEpisodeDelivery(verified);
markReplenishmentEpisodePublishable(ROOT, verified, delivery);
console.log(delivery);
