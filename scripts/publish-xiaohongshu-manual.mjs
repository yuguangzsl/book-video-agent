#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "./lib/filesystem.mjs";
import { buildXiaohongshuManualPayload } from "./lib/manual-publisher.mjs";
import { buildPublicationBrief } from "./lib/publication-workflow.mjs";

const ROOT = process.cwd();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PANEL_SCRIPT = path.join(SCRIPT_DIR, "publish-xiaohongshu-panel.ps1");
const MANUAL_PUBLISHER_ROOT = path.join(ROOT, ".agents", "manual-publisher", "xiaohongshu");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function launchPanel(payloadPath) {
  const launcher = [
    `$panelPath = ${powershellLiteral(PANEL_SCRIPT)}`,
    `$payloadPath = ${powershellLiteral(payloadPath)}`,
    "$panelArgument = '\"' + $panelPath + '\"'",
    "$payloadArgument = '\"' + $payloadPath + '\"'",
    "$argumentList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', $panelArgument, '-PayloadPath', $payloadArgument)",
    "$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -PassThru",
    "[Console]::Write($process.Id)",
  ].join("; ");
  const encodedCommand = Buffer.from(launcher, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedCommand,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  assert(result.status === 0, `Failed to launch Xiaohongshu panel: ${String(result.stderr || result.stdout).trim()}`);
  const pid = Number(String(result.stdout || "").trim());
  assert(Number.isInteger(pid) && pid > 0, "Xiaohongshu panel launcher did not return a process id");
  return pid;
}

function main() {
  assert(process.platform === "win32", "The Xiaohongshu manual panel currently requires Windows");
  assert(fs.existsSync(PANEL_SCRIPT), `Missing Xiaohongshu panel script: ${PANEL_SCRIPT}`);
  const args = parseArgs(process.argv.slice(2));
  const brief = buildPublicationBrief(ROOT, {
    position: args.position === undefined ? undefined : Number(args.position),
    book: args.book,
  });
  const testMode = args.test === true;
  const expectedStatus = testMode ? "published" : "pending";
  assert(
    brief.queueStatus.xiaohongshu === expectedStatus,
    `xiaohongshu must be ${expectedStatus} for queue item ${brief.queuePosition}${testMode ? " in test mode" : ""}`,
  );
  const payload = buildXiaohongshuManualPayload(brief, { testMode });
  fs.mkdirSync(MANUAL_PUBLISHER_ROOT, { recursive: true });
  const payloadPath = path.join(MANUAL_PUBLISHER_ROOT, `${payload.releaseId}.json`);
  writeFileAtomically(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });

  if (args["validate-only"] === true) {
    printJson({ validated: true, payloadPath, ...payload });
    return;
  }

  const pid = launchPanel(payloadPath);
  printJson({
    launched: true,
    pid,
    platform: payload.platform,
    testMode: payload.testMode,
    queuePosition: payload.queuePosition,
    book: payload.book,
    payloadPath,
    videoPath: payload.videoPath,
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
  process.exitCode = 1;
}
