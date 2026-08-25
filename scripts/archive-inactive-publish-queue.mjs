#!/usr/bin/env node

import { archiveInactivePublishQueueItems } from "./lib/publish-queue.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args["confirm-archive-inactive"] !== true) {
    throw new Error("Refusing to archive queue items without --confirm-archive-inactive");
  }
  const result = archiveInactivePublishQueueItems(process.cwd(), { reason: args.reason });
  process.stdout.write(`${JSON.stringify({
    changed: result.changed,
    archivedCount: result.archivedCount,
    positions: result.positions,
    queuePath: result.filePath,
    archivePath: result.archivePath,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
  process.exitCode = 1;
}
