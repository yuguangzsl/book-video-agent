#!/usr/bin/env node

import { validateCompletedEpisode } from "./lib/episode-checks.mjs";
import { readPublishQueue } from "./lib/publish-queue.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const verify = args.includes("--verify");

if (args.some((arg) => arg !== "--verify")) {
  console.error("Usage: node scripts/inspect-publish-queue.mjs [--verify]");
  process.exit(1);
}

const queue = readPublishQueue(ROOT, { required: true });
if (!verify) {
  process.stdout.write(`${JSON.stringify(queue, null, 2)}\n`);
} else {
  const items = queue.items.map((item) => {
    const result = validateCompletedEpisode(ROOT, item.book, item.scriptVersion, {
      requirePublish: true,
      requireQueue: true,
    });
    return {
      ...item,
      videoPath: result.outputPath,
      renderSha256: result.manifest.output.sha256,
    };
  });
  process.stdout.write(`${JSON.stringify({
    verifiedAt: new Date().toISOString(),
    count: items.length,
    items,
  }, null, 2)}\n`);
}
