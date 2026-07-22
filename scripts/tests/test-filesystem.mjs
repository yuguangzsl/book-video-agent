import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyDirectory, removeDirectory } from "../lib/filesystem.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-filesystem-test-"));
const source = path.join(root, "source");
const target = path.join(root, "target");
fs.mkdirSync(path.join(source, "nested"), { recursive: true });
fs.writeFileSync(path.join(source, "root.txt"), "root");
fs.writeFileSync(path.join(source, "nested", "child.txt"), "child");

copyDirectory(source, target);
assert.equal(fs.readFileSync(path.join(target, "root.txt"), "utf8"), "root");
assert.equal(fs.readFileSync(path.join(target, "nested", "child.txt"), "utf8"), "child");

removeDirectory(root);
assert.equal(fs.existsSync(root), false);
console.log("filesystem tests: ok");
