#!/usr/bin/env node

import { validateCompletedEpisode } from "./lib/episode-checks.mjs";
import {
  beginReplenishmentBatch,
  readReplenishmentBatch,
} from "./lib/replenishment-batch.mjs";

const ROOT = process.cwd();
const [action, ...args] = process.argv.slice(2);

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (action === "begin") {
  print(beginReplenishmentBatch(ROOT, args));
} else if (action === "status") {
  print(readReplenishmentBatch(ROOT, { required: true }));
} else if (action === "verify") {
  const batch = readReplenishmentBatch(ROOT, { required: true });
  if (batch.status !== "complete") {
    throw new Error(`Stock replenishment batch ${batch.batchId} is not complete`);
  }
  const items = batch.items.map((item) => {
    const result = validateCompletedEpisode(ROOT, item.book, "", {
      requirePublish: true,
      requireQueue: true,
    });
    return {
      book: result.episodeName,
      videoPath: result.outputPath,
      title: result.publish.copy.selectedTitle,
      description: result.publish.copy.description,
      scriptVersion: result.scriptVersion,
      renderSha256: result.manifest.output.sha256,
    };
  });
  print({
    batchId: batch.batchId,
    status: "verified",
    verifiedAt: new Date().toISOString(),
    count: items.length,
    items,
  });
} else {
  console.error("Usage: node scripts/manage-stock-replenishment.mjs begin <sample-book> [book...]");
  console.error("       node scripts/manage-stock-replenishment.mjs status");
  console.error("       node scripts/manage-stock-replenishment.mjs verify");
  process.exit(1);
}
