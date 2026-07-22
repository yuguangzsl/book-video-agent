#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { resolveCommand } from "./lib/command.mjs";
import { normalizeDisplayTitle } from "./lib/title-normalization.mjs";
import { readEnvValue } from "./lib/env.mjs";
import { pruneProjectTempArtifacts } from "./lib/temp-lifecycle.mjs";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const PIPELINE_PATH = path.join(DATA_DIR, "book-pipeline.csv");
const EXAMPLE_PATH = path.join(DATA_DIR, "book-pipeline.example.csv");
const STATE_PATH = path.join(ROOT, ".book-automation-state.json");
const ENV_PATH = path.join(ROOT, ".env");
const WHISPER_MODEL_PATH = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
const MIN_WHISPER_MODEL_BYTES = 100 * 1024 * 1024;
const HYPERFRAMES_VERSION = "0.7.33";
const WEREAD_SKILLS_URL = "https://weread.qq.com/r/weread-skills";
const VALID_MODES = new Set(["--check", "--apply", "--configure-weread"]);
const REQUIRED_RUNTIME_CHECKS = ["node", "ffmpeg", "ffprobe", "npx", "whisper", "whisperModel"];

function commandAvailable(command) {
  const args = command === "ffmpeg" ? ["-hide_banner", "-h"] : command === "ffprobe" ? ["-version"] : ["--version"];
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, { stdio: "ignore", shell: false });
  return result.status === 0;
}

function fileExists(filePath, minimumBytes = 0) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  return stat.isFile() && stat.size >= minimumBytes;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { current += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { values.push(current); current = ""; }
    else current += char;
  }
  values.push(current);
  return values;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function csvRow(values) { return values.map(csvEscape).join(","); }

function readCsv(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u);
  const headers = parseCsvLine(lines.shift() || "");
  return { headers, rows: lines.filter(Boolean).map((line) => Object.fromEntries(headers.map((header, index) => [header, parseCsvLine(line)[index] || ""])))};
}

function secureLocalSecretFile(filePath) {
  fs.chmodSync(filePath, 0o600);
  if (process.platform !== "win32") return;

  const username = os.userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();
  const principal = domain ? `${domain}\\${username}` : username;
  const result = spawnSync(
    "icacls",
    [filePath, "/inheritance:r", "/grant:r", `${principal}:(F)`],
    { encoding: "utf8", shell: false, windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error("Could not restrict .env permissions to the current Windows user.");
  }
}

function writeEnvKey(key) {
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/u) : [];
  const lines = existing.filter((line) => !/^\s*(?:export\s+)?WEREAD_API_KEY\s*=/u.test(line));
  if (key) lines.push(`WEREAD_API_KEY=${key}`);
  const tempPath = `${ENV_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${lines.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
    secureLocalSecretFile(tempPath);
    fs.renameSync(tempPath, ENV_PATH);
    secureLocalSecretFile(ENV_PATH);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function getWereadApiKey() {
  return process.env.WEREAD_API_KEY || readEnvValue("WEREAD_API_KEY", ENV_PATH);
}

function readHidden(prompt) {
  if (!input.isTTY || !input.setRawMode) {
    throw new Error("WeChat Reading configuration requires an interactive terminal; never send the API key in chat or pass it as a command argument.");
  }
  output.write(prompt);
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk) => {
      const text = String(chunk);
      if (text === "\u0003") { input.setRawMode(false); input.pause(); output.write("\n"); process.exit(130); }
      if (text === "\r" || text === "\n") {
        input.setRawMode(false); input.pause(); input.removeListener("data", onData); output.write("\n"); resolve(value.trim()); return;
      }
      if (text === "\u0008" || text === "\u007f") value = value.slice(0, -1); else value += text;
    };
    input.setRawMode(true); input.resume(); input.setEncoding("utf8"); input.on("data", onData);
  });
}

function migratePipeline() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PIPELINE_PATH)) { fs.copyFileSync(EXAMPLE_PATH, PIPELINE_PATH); return "created"; }
  const { headers, rows } = readCsv(PIPELINE_PATH);
  if (!headers.length || !headers.includes("title")) return rows.length ? "ready" : "empty";

  const nextHeaders = headers.map((header) => header === "title" ? "source_title" : header === "bookId" ? "source_book_id" : header);
  if (!nextHeaders.includes("display_title")) nextHeaders.splice(2, 0, "display_title");
  if (!nextHeaders.includes("source_channel")) nextHeaders.splice(5, 0, "source_channel");
  const backup = path.join(DATA_DIR, `.book-pipeline-backup-${Date.now()}.csv`);
  fs.copyFileSync(PIPELINE_PATH, backup);
  const migrated = rows.map((row) => {
    const output = { ...row, source_title: row.source_title || row.title || "", source_book_id: row.source_book_id || row.bookId || "" };
    output.display_title = output.display_title || normalizeDisplayTitle(output.source_title);
    output.source_channel = output.source_channel || (output.source_book_id ? "weread" : "unknown");
    delete output.title; delete output.bookId;
    return output;
  });
  fs.writeFileSync(PIPELINE_PATH, `${[csvRow(nextHeaders), ...migrated.map((row) => csvRow(nextHeaders.map((header) => row[header] || "")))].join("\n")}\n`);
  return "migrated";
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return null; }
}

function collectChecks() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const wereadConfigured = Boolean(getWereadApiKey());
  return {
    node: nodeMajor >= 22,
    ffmpeg: commandAvailable("ffmpeg"),
    ffprobe: commandAvailable("ffprobe"),
    npx: commandAvailable("npx"),
    whisper: commandAvailable("whisper-cli"),
    whisperModel: fileExists(WHISPER_MODEL_PATH, MIN_WHISPER_MODEL_BYTES),
    whisperModelBytes: fs.existsSync(WHISPER_MODEL_PATH) ? fs.statSync(WHISPER_MODEL_PATH).size : 0,
    whisperModelPath: path.relative(ROOT, WHISPER_MODEL_PATH),
    whisperModelDownload: "node scripts/download-whisper-model.mjs",
    hyperframes: `npx hyperframes@${HYPERFRAMES_VERSION}`,
    weread: wereadConfigured ? "enabled" : "not_configured",
    wereadApiKey: wereadConfigured,
    wereadApiKeySource: process.env.WEREAD_API_KEY ? "process-env" : wereadConfigured ? "repo-env" : "none",
    platform: `${process.platform}-${os.arch()}`,
  };
}

function missingRuntimeChecks(checks) {
  return REQUIRED_RUNTIME_CHECKS.filter((name) => !checks[name]);
}

function runCheck() {
  const checks = collectChecks();
  const state = readState();
  console.log(JSON.stringify({
    mode: "check",
    state: state ? "present" : "missing",
    pipeline: fs.existsSync(PIPELINE_PATH) ? "present" : "missing",
    checks,
  }, null, 2));
  if (missingRuntimeChecks(checks).length) process.exitCode = 1;
}

function runApply() {
  const checks = collectChecks();
  const missing = missingRuntimeChecks(checks);
  if (missing.length) {
    throw new Error(`Cannot apply initialization until required runtime checks pass: ${missing.join(", ")}`);
  }

  const previousState = readState();
  const tempCleanup = pruneProjectTempArtifacts(ROOT);
  const pipelineStatus = migratePipeline();
  const state = {
    schemaVersion: 1,
    initializedAt: previousState?.initializedAt || new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    weread: checks.weread,
    imageCapability: process.env.CODEX_IMAGE_CAPABILITY || "agent-managed",
  };
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ mode: "apply", pipeline: pipelineStatus, tempCleanup, state, checks }, null, 2));
}

async function configureWeread() {
  if (getWereadApiKey()) {
    console.log(JSON.stringify({ mode: "configure-weread", weread: "enabled", changed: false }, null, 2));
    return;
  }

  console.log(`请打开微信读书 Skills 官网获取 API Key：${WEREAD_SKILLS_URL}`);
  const key = await readHidden("请输入微信读书 API Key（输入内容不会显示）：");
  if (!key) throw new Error("No API key was entered; configuration was not changed.");
  writeEnvKey(key);
  console.log(JSON.stringify({ mode: "configure-weread", weread: "enabled", changed: true }, null, 2));
}

async function main() {
  const [mode = "--check", ...extraArgs] = process.argv.slice(2);
  if (!VALID_MODES.has(mode) || extraArgs.length) {
    throw new Error("Usage: node scripts/init.mjs [--check | --apply | --configure-weread]. API keys are never accepted as command arguments.");
  }
  if (mode === "--check") runCheck();
  else if (mode === "--apply") runApply();
  else await configureWeread();
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
