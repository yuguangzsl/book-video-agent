#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportDotPublication, exportDotPublicationCalendar } from "./lib/dot-publication-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "node scripts/export-dot-publication.mjs (--plan <JSON-file> | --position <n> --publish-date YYYY-MM-DD [--media-url <HTTPS>] [--account-id <public-id>] [--publish-time HH:mm] [--hold-reason <text>]) [--output <dir>]";
const KEYS = {
  position: "position", "media-url": "mediaUrl", output: "output", "account-id": "accountId",
  "publish-date": "publishDate", "publish-time": "publishTime", "hold-reason": "holdReason", plan: "plan",
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
    let result;
    if (options.plan) {
      if (Object.keys(options).some((key) => !["plan", "output"].includes(key))) {
        throw new Error("--plan cannot be combined with single-task arguments");
      }
      const plan = JSON.parse(fs.readFileSync(path.resolve(options.plan), "utf8"));
      if (!plan || typeof plan !== "object" || Array.isArray(plan)
        || Object.keys(plan).some((key) => key !== "entries")) throw new Error("Plan must contain only entries");
      result = exportDotPublicationCalendar(ROOT, { entries: plan.entries, output: options.output });
    } else {
      result = exportDotPublication(ROOT, options);
    }
    process.stdout.write(`${JSON.stringify({
      status: "exported",
      tasks: result.tasks.map((task) => ({
        publishDate: task.schedule.date, status: task.status, submitAuthorized: task.submitAuthorized,
        taskId: task.taskId, blockedReasons: task.blockedReasons,
        taskFile: result.current.entries[task.schedule.date].taskFile,
      })),
      currentFile: result.currentFile,
    }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
