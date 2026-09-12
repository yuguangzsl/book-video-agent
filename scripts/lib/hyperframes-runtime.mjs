import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandSync } from "./command.mjs";

const RESOLUTION_MARKER = "HYPERFRAMES_RUNTIME=";

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("HyperFrames requires an exact release version");
}

export function validateHyperframesEntry(packageDirectory, version) {
  assertVersion(version);
  const root = fs.realpathSync(packageDirectory);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (metadata.name !== "hyperframes" || metadata.version !== version) {
    throw new Error("HyperFrames package identity does not match the pinned version");
  }
  const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.hyperframes;
  if (typeof bin !== "string" || !bin) throw new Error("HyperFrames CLI entry is missing");
  const entry = fs.realpathSync(path.resolve(root, bin));
  const relative = path.relative(root, entry);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
    || !/\.[cm]?js$/u.test(entry) || !fs.statSync(entry).isFile()) {
    throw new Error("HyperFrames CLI entry must be a JavaScript file inside its package");
  }
  return entry;
}

// npm exec documents that --package adds the requested package's executables to PATH.
// Inspect only those active .bin directories, never scan npm's private cache layout.
export function findHyperframesPackage(searchPath, version) {
  assertVersion(version);
  for (const directory of String(searchPath || "").split(path.delimiter)) {
    if (path.basename(directory).toLowerCase() !== ".bin") continue;
    if (!["hyperframes", "hyperframes.cmd"].some((name) => fs.existsSync(path.join(directory, name)))) continue;
    const packageDirectory = path.resolve(directory, "..", "hyperframes");
    try {
      validateHyperframesEntry(packageDirectory, version);
      return packageDirectory;
    } catch {
      // A different local version can precede npm's explicitly requested version.
    }
  }
  throw new Error("Pinned HyperFrames package was not found on npm exec PATH");
}

export function resolveHyperframesRuntime(root, version, { run = runCommandSync, warn = console.warn } = {}) {
  assertVersion(version);
  try {
    const result = run("npx", [
      "--yes", "--package", `hyperframes@${version}`, "--call",
      `node scripts/lib/hyperframes-runtime.mjs --resolve ${version}`,
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    const records = String(result.stdout || "").split(/\r?\n/u).filter((line) => line.startsWith(RESOLUTION_MARKER));
    if (records.length !== 1) throw new Error("HyperFrames runtime resolution did not return one identity");
    const resolved = JSON.parse(records[0].slice(RESOLUTION_MARKER.length));
    const entry = validateHyperframesEntry(resolved.packageDirectory, version);
    return { command: process.execPath, args: [entry] };
  } catch {
    warn("HyperFrames CLI reuse unavailable; using pinned npx commands for this render.");
    return { command: "npx", args: ["--yes", `hyperframes@${version}`] };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--resolve") throw new Error("Expected --resolve <exact-version>");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  const packageDirectory = findHyperframesPackage(process.env[pathKey], process.argv[3]);
  console.log(`${RESOLUTION_MARKER}${JSON.stringify({ packageDirectory })}`);
}
