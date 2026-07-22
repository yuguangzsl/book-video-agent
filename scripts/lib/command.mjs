import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function resolveCommand(command, args = []) {
  if (command !== "npx" || process.platform !== "win32") return { command, args };

  const candidates = [
    process.env.npm_execpath?.replace(/npm-cli\.js$/u, "npx-cli.js"),
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
  ].filter(Boolean);
  const npxCli = candidates.find((candidate) => fs.existsSync(candidate));
  return npxCli
    ? { command: process.execPath, args: [npxCli, ...args] }
    : { command, args };
}

export function spawnCommandSync(command, args = [], options = {}) {
  const resolved = resolveCommand(command, args);
  return spawnSync(resolved.command, resolved.args, {
    encoding: "utf8",
    ...options,
    shell: false,
  });
}

export function runCommandSync(command, args = [], options = {}) {
  const result = spawnCommandSync(command, args, options);
  if (result.status !== 0) {
    const detail = result.error?.message
      || String(result.stderr || result.stdout || "").trim()
      || `status=${result.status ?? "unknown"}, signal=${result.signal || "none"}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return result;
}
