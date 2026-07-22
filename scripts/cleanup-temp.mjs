#!/usr/bin/env node

import { pruneProjectTempArtifacts } from "./lib/temp-lifecycle.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allManaged = args.includes("--all-managed");
const olderThanIndex = args.indexOf("--older-than-hours");
const olderThanHours = olderThanIndex === -1 ? 24 : Number(args[olderThanIndex + 1]);
const accepted = new Set(["--dry-run", "--all-managed", "--older-than-hours"]);
const unknown = args.filter((value, index) => {
  if (index === olderThanIndex + 1) return false;
  return !accepted.has(value);
});

if (unknown.length || !Number.isFinite(olderThanHours) || olderThanHours < 0) {
  console.error("Usage: node scripts/cleanup-temp.mjs [--dry-run] [--all-managed] [--older-than-hours <hours>]");
  process.exit(1);
}

const result = pruneProjectTempArtifacts(ROOT, { dryRun, allManaged, olderThanHours });
console.log(JSON.stringify({ dryRun, allManaged, olderThanHours, ...result }, null, 2));
