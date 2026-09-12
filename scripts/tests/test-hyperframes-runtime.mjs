import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommandSync } from "../lib/command.mjs";
import {
  findHyperframesPackage,
  resolveHyperframesRuntime,
  validateHyperframesEntry,
} from "../lib/hyperframes-runtime.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-hyperframes-runtime-"));
const version = "0.7.33";
function fixture(name, metadata) {
  const modules = path.join(root, name, "node_modules");
  const directory = path.join(modules, "hyperframes");
  fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
  fs.mkdirSync(path.join(modules, ".bin"), { recursive: true });
  fs.writeFileSync(path.join(modules, ".bin", "hyperframes.cmd"), "@echo off\n");
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(metadata));
  fs.writeFileSync(path.join(directory, "dist", "cli.cjs"), "console.log(process.argv.slice(2).join('|'));\n");
  return { directory, bin: path.join(modules, ".bin") };
}

try {
  const metadata = { name: "hyperframes", version, bin: { hyperframes: "dist/cli.cjs" } };
  const older = fixture("local", { ...metadata, version: "0.7.32" });
  const correct = fixture("npm cache path with spaces 中文", metadata);
  assert.throws(() => validateHyperframesEntry(older.directory, version), /identity/u);
  assert.equal(findHyperframesPackage([older.bin, correct.bin].join(path.delimiter), version), correct.directory);
  assert.throws(() => findHyperframesPackage(older.bin, version), /not found/u);
  assert.throws(() => findHyperframesPackage(correct.bin, "latest"), /exact release/u);

  let resolutions = 0;
  const runtime = resolveHyperframesRuntime(root, version, {
    run(command, args, options) {
      resolutions += 1;
      assert.equal(command, "npx");
      assert.deepEqual(args.slice(0, 4), ["--yes", "--package", "hyperframes@0.7.33", "--call"]);
      assert.equal(args[4], "node scripts/lib/hyperframes-runtime.mjs --resolve 0.7.33");
      assert.equal(options.cwd, root);
      return { stdout: `npm diagnostic\nHYPERFRAMES_RUNTIME=${JSON.stringify({ packageDirectory: correct.directory })}\n` };
    },
    warn() { assert.fail("valid runtime must not fall back"); },
  });
  assert.equal(runtime.command, process.execPath);
  for (const command of ["lint", "validate", "inspect", "render"]) {
    const result = runCommandSync(runtime.command, [...runtime.args, command, "a path with spaces 中文"]);
    assert.equal(result.stdout.trim(), `${command}|a path with spaces 中文`);
  }
  assert.equal(resolutions, 1);

  const warnings = [];
  for (const run of [
    () => { throw new Error("private-command-secret"); },
    () => ({ stdout: "unexpected output" }),
    () => ({ stdout: `HYPERFRAMES_RUNTIME=${JSON.stringify({ packageDirectory: older.directory })}` }),
  ]) {
    assert.deepEqual(resolveHyperframesRuntime(root, version, { run, warn: (line) => warnings.push(line) }), {
      command: "npx", args: ["--yes", "hyperframes@0.7.33"],
    });
  }
  assert.equal(warnings.length, 3);
  assert.equal(warnings.join(" ").includes("private-command-secret"), false);

  const outsideEntry = path.join(root, "outside.cjs");
  fs.writeFileSync(outsideEntry, "throw new Error('must never execute');\n");
  const escaping = fixture("escaping", { ...metadata, bin: { hyperframes: path.relative(path.join(root, "escaping", "node_modules", "hyperframes"), outsideEntry) } });
  assert.throws(() => validateHyperframesEntry(escaping.directory, version), /inside its package/u);
  const wrongName = fixture("wrong-name", { ...metadata, name: "unrelated-package" });
  assert.throws(() => validateHyperframesEntry(wrongName.directory, version), /identity/u);
  const missingBin = fixture("missing-bin", { name: "hyperframes", version });
  assert.throws(() => validateHyperframesEntry(missingBin.directory, version), /entry is missing/u);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("HyperFrames runtime reuse tests: ok");
