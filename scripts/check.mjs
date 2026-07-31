#!/usr/bin/env node

import path from "node:path";
import { runCommandSync } from "./lib/command.mjs";

const ROOT = process.cwd();

for (const script of ["check-unit.mjs", "check-assets.mjs", "check-template.mjs"]) {
  runCommandSync(process.execPath, [path.join(ROOT, "scripts", script)], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

console.log("book-video checks: ok");
