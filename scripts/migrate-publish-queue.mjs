#!/usr/bin/env node

import { migratePublishQueueToSchemaV2 } from "./lib/publish-queue.mjs";

try {
  const result = migratePublishQueueToSchemaV2(process.cwd());
  process.stdout.write(`${JSON.stringify({
    migratedAt: result.migratedAt,
    schemaVersion: result.queue.schemaVersion,
    count: result.queue.items.length,
    backupPath: result.backupPath,
    queuePath: result.filePath,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
  process.exitCode = 1;
}
