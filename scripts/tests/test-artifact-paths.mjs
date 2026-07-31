import assert from "node:assert/strict";
import path from "node:path";
import {
  assertPortableProjectPath,
  formatMarkdownLocalPath,
  resolveProjectPath,
  toPortableProjectPath,
} from "../lib/artifact-paths.mjs";

const root = path.resolve("test-project-root");
const filePath = path.join(root, "episodes", "书名", "script.csv");
assert.equal(toPortableProjectPath(root, filePath), "episodes/书名/script.csv");
assert.equal(resolveProjectPath(root, "episodes/书名/script.csv"), filePath);
assert.equal(assertPortableProjectPath("episodes/书名/script.csv"), "episodes/书名/script.csv");
assert.throws(() => assertPortableProjectPath("episodes\\书名\\script.csv"), /forward slashes/);
assert.throws(() => assertPortableProjectPath("../secret.txt"), /normalized project-relative/);
assert.throws(() => toPortableProjectPath(root, path.resolve(root, "..", "secret.txt")), /outside the project root/);
assert.match(formatMarkdownLocalPath(path.join(root, "folder with space", "video.mp4")), /^<.*folder with space.*>$/u);
assert.match(formatMarkdownLocalPath(path.join(root, "folder(with-parentheses)", "video.mp4")), /^<.*folder\(with-parentheses\).*?>$/u);
console.log("artifact paths: ok");
