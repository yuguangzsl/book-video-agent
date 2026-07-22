#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnCommandSync } from "./lib/command.mjs";
import { copyDirectory, removeDirectory } from "./lib/filesystem.mjs";
import { readJsonFile } from "./lib/json.mjs";
import { HYPERFRAMES_CHECK_TIMEOUT_MS, HYPERFRAMES_VERSION } from "./lib/project-constants.mjs";

const ROOT = process.cwd();
const hyperframesEnv = {
  ...process.env,
  PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS: String(HYPERFRAMES_CHECK_TIMEOUT_MS),
};

function requireCommand(command, args) {
  const result = spawnCommandSync(command, args, { cwd: ROOT, stdio: "ignore" });
  if (result.status !== 0) throw new Error(`Missing or unusable required command: ${command}`);
}

requireCommand("ffmpeg", ["-hide_banner", "-h"]);
requireCommand("ffprobe", ["-version"]);
requireCommand("npx", ["--version"]);

const templateSourceDir = path.join(ROOT, "templates", "shared-video-template", "intro");
const templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-hyperframes-check-"));
const templateDir = path.join(templateRoot, "intro");

try {
  copyDirectory(templateSourceDir, templateDir);
  const introBooks = readJsonFile(path.join(templateDir, "default-book-list.json"));
  const indexPath = path.join(templateDir, "index.html");
  let html = fs.readFileSync(indexPath, "utf8")
    .replaceAll("{{TARGET_TITLE}}", "《测试书名》")
    .replaceAll("{{TARGET_AUTHOR}}", "测试作者 / 著");
  introBooks.forEach((book, index) => {
    html = html
      .replaceAll(`{{LIST_TITLE_${index + 1}}}`, `《${book.title}》`)
      .replaceAll(`{{LIST_AUTHOR_${index + 1}}}`, `${book.author} / 著`);
  });
  fs.writeFileSync(indexPath, html);
  const resultPlaceholder = path.join(templateDir, "media", "pages", "result.png");
  const resultSource = path.join(templateDir, "media", "intro-background.jpg");
  const resultConversion = spawnCommandSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", resultSource, "-frames:v", "1", resultPlaceholder,
  ], { cwd: ROOT });
  if (resultConversion.status !== 0) throw new Error("Could not create temporary HyperFrames result placeholder");

  for (const command of ["lint", "validate", "inspect"]) {
    const args = ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, command, "--json"];
    if (command === "validate") args.push("--no-contrast", "--timeout", String(HYPERFRAMES_CHECK_TIMEOUT_MS));
    if (command === "inspect") {
      args.push("--strict", "--timeout", String(HYPERFRAMES_CHECK_TIMEOUT_MS), "--at", "0.2,0.75,1.2,1.7,2.08,2.25,2.55,3.2,3.8,4.15");
    }
    args.push(templateDir);
    const result = spawnCommandSync("npx", args, { cwd: ROOT, stdio: "inherit", env: hyperframesEnv });
    if (result.status !== 0) throw new Error(`HyperFrames ${command} failed`);
  }
} finally {
  removeDirectory(templateRoot);
}

console.log("template checks: ok");
