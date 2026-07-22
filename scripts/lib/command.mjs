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
