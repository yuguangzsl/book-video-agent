#!/usr/bin/env node

import {
  migrateProductionLedger,
  summarizeProductionWork,
} from "./lib/production-ledger.mjs";

function parseArgs(argv) {
  const args = {};
  for (const value of argv) {
    if (value.startsWith("--")) args[value.slice(2)] = true;
  }
  return args;
}

function summary(ledger) {
  const works = Object.values(ledger.works).map((work) => summarizeProductionWork(ledger, work.workId));
  return {
    workCount: works.length,
    generatedWorkCount: works.filter((work) => work.everGenerated).length,
    releasedWorkCount: works.filter((work) => work.everReleased).length,
    douyinPublishedWorkCount: works.filter((work) => work.platforms.douyin.everPublished).length,
    operationalPublishedWorkCount: works.filter((work) => work.platforms.douyin.everPublished).length,
    xiaohongshuTrackingMode: "follow_douyin",
    historicalXiaohongshuProofWorkCount: works.filter((work) => work.platforms.xiaohongshu.everPublished).length,
    releaseCount: Object.keys(ledger.releases).length,
    renderCount: Object.keys(ledger.renders).length,
    unresolvedReferenceCount: ledger.unresolvedReferences.length,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = migrateProductionLedger(process.cwd(), {
    write: args.check !== true,
    verifyMedia: args["skip-media"] !== true,
  });
  process.stdout.write(`${JSON.stringify({
    mode: args.check === true ? "check" : "migrate",
    wrote: result.wrote,
    filePath: result.filePath,
    sourceCounts: result.sourceCounts,
    ledger: summary(result.ledger),
    warnings: result.warnings,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
  process.exitCode = 1;
}
