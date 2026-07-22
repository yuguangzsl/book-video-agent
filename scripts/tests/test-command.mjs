import assert from "node:assert/strict";
import path from "node:path";
import { resolveCommand } from "../lib/command.mjs";

const args = ["--version"];
assert.deepEqual(resolveCommand("ffmpeg", args), { command: "ffmpeg", args });

const resolvedNpx = resolveCommand("npx", args);
if (process.platform === "win32") {
  assert.equal(resolvedNpx.command, process.execPath);
  assert.equal(path.basename(resolvedNpx.args[0]), "npx-cli.js");
  assert.deepEqual(resolvedNpx.args.slice(1), args);
} else {
  assert.deepEqual(resolvedNpx, { command: "npx", args });
}

console.log("command resolution tests: ok");
