#!/usr/bin/env node

import { checkBookEligibility } from "./lib/generated-title-index.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const maintenance = args.includes("--maintenance");
const positional = args.filter((arg) => !arg.startsWith("--"));

if (positional.length !== 1 || args.some((arg) => arg.startsWith("--") && arg !== "--maintenance")) {
  console.error("Usage: node scripts/check-book-eligibility.mjs <display-title> [--maintenance]");
  process.exit(1);
}

const result = checkBookEligibility(ROOT, positional[0], { maintenance });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.eligible) process.exitCode = 2;
