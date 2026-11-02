#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportDotPublication } from "./lib/dot-publication-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "node scripts/export-dot-publication.mjs --position <n> [--media-url <HTTPS>] [--output <dir>] [--account-id <public-id>] [--publish-date YYYY-MM-DD] [--publish-time HH:mm] [--hold-reason <text>]";
const KEYS = {
  position: "position", "media-url": "mediaUrl", output: "output", "account-id": "accountId",
  "publish-date": "publishDate", "publish-time": "publishTime", "hold-reason": "holdReason",
};

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${USAGE}\n`);
  } else {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = KEYS[args[index]?.slice(2)];
      const value = args[index + 1];
      if (!args[index]?.startsWith("--") || !key || !value || value.startsWith("--") || Object.hasOwn(options, key)) {
        throw new Error(`Invalid or duplicate argument. Usage: ${USAGE}`);
      }
      options[key] = value;
    }
    const result = exportDotPublication(ROOT, options);
    process.stdout.write(`${JSON.stringify({
      status: result.task.status,
      submitAuthorized: result.task.submitAuthorized,
      taskId: result.task.taskId,
      blockedReasons: result.task.blockedReasons,
      taskFile: result.current.taskFile,
      currentFile: "daily/current.json",
    }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
