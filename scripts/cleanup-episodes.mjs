#!/usr/bin/env node

import { cleanupEpisodes } from "./lib/episode-cleanup.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = args.includes("--dry-run");

if (args.some((arg) => !["--apply", "--dry-run"].includes(arg)) || apply === dryRun) {
  console.error("Usage: node scripts/cleanup-episodes.mjs --dry-run");
  console.error("       node scripts/cleanup-episodes.mjs --apply");
  process.exit(1);
}

const result = cleanupEpisodes(process.cwd(), { apply });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
