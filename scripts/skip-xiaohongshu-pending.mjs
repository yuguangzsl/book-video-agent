#!/usr/bin/env node

import { skipPendingXiaohongshuItems } from "./lib/publish-queue.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const confirm = args.includes("--confirm-skip-all");
const reasonIndex = args.indexOf("--reason");
const reason = reasonIndex >= 0 ? String(args[reasonIndex + 1] || "").trim() : "";
const allowed = new Set(["--confirm-skip-all", "--reason", reason]);

if (!confirm || !reason || args.some((arg) => !allowed.has(arg))) {
  console.error('Usage: node scripts/skip-xiaohongshu-pending.mjs --confirm-skip-all --reason "<reason>"');
  process.exit(1);
}

const result = skipPendingXiaohongshuItems(ROOT, { reason });
process.stdout.write(`${JSON.stringify({
  changed: result.changed,
  skippedCount: result.skippedCount,
  positions: result.positions,
  path: result.filePath,
}, null, 2)}\n`);
