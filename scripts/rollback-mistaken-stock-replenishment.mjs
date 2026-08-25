#!/usr/bin/env node

import { rollbackMistakenStockReplenishment } from "./lib/mistaken-stock-replenishment-rollback.mjs";

function usage() {
  return [
    "Usage: node scripts/rollback-mistaken-stock-replenishment.mjs --dry-run",
    "       node scripts/rollback-mistaken-stock-replenishment.mjs --apply --confirm-mistaken-stock-rollback",
  ].join("\n");
}

try {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");
  const confirmed = args.includes("--confirm-mistaken-stock-rollback");
  const allowed = new Set(["--dry-run", "--apply", "--confirm-mistaken-stock-rollback"]);
  if (args.some((arg) => !allowed.has(arg)) || dryRun === apply || (dryRun && confirmed) || (apply && !confirmed)) {
    throw new Error(usage());
  }
  const result = rollbackMistakenStockReplenishment(process.cwd(), { apply });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
