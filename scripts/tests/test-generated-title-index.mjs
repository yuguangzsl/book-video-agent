import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertBookEligible,
  checkBookEligibility,
  readGeneratedTitleIndex,
  recordGeneratedTitle,
} from "../lib/generated-title-index.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-title-index-test-"));

try {
  recordGeneratedTitle(root, "《测试书》（经典版）");
  recordGeneratedTitle(root, "测试书");
  assert.deepEqual(readGeneratedTitleIndex(root), ["测试书"]);
  assert.equal(checkBookEligibility(root, "《测试书》").duplicate, true);
  assert.throws(() => assertBookEligible(root, "测试书"), /already been generated/);
  assert.equal(assertBookEligible(root, "测试书", { maintenance: true }).eligible, true);

  const rendersDir = path.join(root, "episodes", "另一册", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  fs.writeFileSync(path.join(rendersDir, "final.manifest.json"), "{}\n");
  const renderResult = checkBookEligibility(root, "另一册", {
    manifestReader: () => ({ manifest: { episode: { name: "另一册" } } }),
  });
  assert.equal(renderResult.duplicate, true);
  assert.deepEqual(renderResult.matches.validatedRenders, ["另一册"]);

  const warningResult = checkBookEligibility(root, "未生成", {
    manifestReader: () => { throw new Error("invalid render"); },
  });
  assert.equal(warningResult.eligible, true);
  assert.match(warningResult.warnings[0], /invalid render/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("generated title index: ok");
