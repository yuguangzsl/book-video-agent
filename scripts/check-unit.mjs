#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnCommandSync } from "./lib/command.mjs";
import { readJsonFile } from "./lib/json.mjs";

const ROOT = process.cwd();
const scriptsDir = path.join(ROOT, "scripts");
const testsDir = path.join(scriptsDir, "tests");

function collectMjsFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMjsFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(entryPath);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

for (const filePath of collectMjsFiles(scriptsDir)) {
  const result = spawnCommandSync(process.execPath, ["--check", filePath], { cwd: ROOT });
  if (result.status !== 0) throw new Error(`Syntax check failed: ${path.relative(ROOT, filePath)}\n${result.stderr || ""}`);
}

const defaultIntroBooksPath = path.join(ROOT, "templates", "shared-video-template", "intro", "default-book-list.json");
const defaultIntroBooks = readJsonFile(defaultIntroBooksPath);
if (
  !Array.isArray(defaultIntroBooks)
  || defaultIntroBooks.length !== 6
  || defaultIntroBooks.some((book) => !book?.title || !book?.author)
) {
  throw new Error("Default intro book list must contain exactly six books with authors");
}

const testFiles = fs.readdirSync(testsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^test-.*\.mjs$/u.test(entry.name))
  .map((entry) => path.join(testsDir, entry.name))
  .sort((a, b) => a.localeCompare(b));
if (testFiles.length === 0) throw new Error(`No tests found in ${testsDir}`);

for (const testPath of testFiles) {
  const result = spawnCommandSync(process.execPath, [testPath], { cwd: ROOT });
  if (result.status !== 0) {
    throw new Error(`Test failed: ${path.relative(ROOT, testPath)}\n${result.stderr || result.stdout || ""}`);
  }
}

console.log(`unit checks: ok (${testFiles.length} tests)`);
