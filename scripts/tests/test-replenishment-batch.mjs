import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertEpisodeCanRenderForReplenishment,
  beginReplenishmentBatch,
  markReplenishmentEpisodePublishable,
  readReplenishmentBatch,
} from "../lib/replenishment-batch.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-replenishment-test-"));
const books = ["样本书", "第二本", "第三本"];

function result(book, digit) {
  return {
    episodeName: book,
    manifest: { output: { sha256: digit.repeat(64) } },
  };
}

try {
  const batch = beginReplenishmentBatch(root, books, {
    batchId: "batch-test",
    now: new Date("2026-07-27T01:00:00.000Z"),
  });
  assert.equal(batch.sampleBook, "样本书");
  assert.equal(beginReplenishmentBatch(root, books).batchId, "batch-test");
  assert.doesNotThrow(() => assertEpisodeCanRenderForReplenishment(root, "样本书"));
  assert.throws(
    () => assertEpisodeCanRenderForReplenishment(root, "第二本"),
    /sample gate is closed/,
  );

  markReplenishmentEpisodePublishable(root, result("样本书", "a"), "样本交付", {
    now: new Date("2026-07-27T02:00:00.000Z"),
  });
  assert.doesNotThrow(() => assertEpisodeCanRenderForReplenishment(root, "第二本"));
  markReplenishmentEpisodePublishable(root, result("第二本", "b"), "第二本交付", {
    now: new Date("2026-07-27T03:00:00.000Z"),
  });
  markReplenishmentEpisodePublishable(root, result("第三本", "c"), "第三本交付", {
    now: new Date("2026-07-27T04:00:00.000Z"),
  });
  const completed = readReplenishmentBatch(root, { required: true });
  assert.equal(completed.status, "complete");
  assert.equal(completed.items.every((item) => item.stage === "publishable"), true);
  assert.match(completed.items[0].deliverySha256, /^[a-f0-9]{64}$/u);
  assert.equal(fs.existsSync(path.join(root, ".agents", "stock-replenishment.lock")), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("replenishment batch: ok");
