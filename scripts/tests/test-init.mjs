import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INIT_SCRIPT = path.join(ROOT, "scripts", "init.mjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-init-test-"));
const cleanEnv = { ...process.env, WEREAD_API_KEY: "" };

function run(args) {
  return spawnSync(process.execPath, [INIT_SCRIPT, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: cleanEnv,
    shell: false,
  });
}

try {
  for (const args of [[], ["--check"]]) {
    const result = run(args);
    assert.equal(result.signal, null);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, "check");
    assert.equal(output.state, "missing");
    assert.equal(output.pipeline, "missing");
    assert.equal(fs.existsSync(path.join(directory, ".book-automation-state.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "data", "book-pipeline.csv")), false);
    assert.equal(fs.existsSync(path.join(directory, ".env")), false);
  }

  const nonInteractive = run(["--configure-weread"]);
  assert.notEqual(nonInteractive.status, 0);
  assert.match(nonInteractive.stderr, /interactive terminal/u);
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);

  const blockedApply = run(["--apply"]);
  assert.notEqual(blockedApply.status, 0);
  assert.match(blockedApply.stderr, /whisperModel/u);
  assert.equal(fs.existsSync(path.join(directory, ".book-automation-state.json")), false);
  assert.equal(fs.existsSync(path.join(directory, "data", "book-pipeline.csv")), false);

  const rejectedArgument = run(["--configure-weread", "must-not-appear"]);
  assert.notEqual(rejectedArgument.status, 0);
  assert.doesNotMatch(`${rejectedArgument.stdout}${rejectedArgument.stderr}`, /must-not-appear/u);
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("init tests: ok");
