import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { formatCompletedEpisodeDelivery } from "../lib/episode-checks.mjs";
import { verifyReplenishmentBatch } from "../manage-stock-replenishment.mjs";

const root = path.resolve("stock-replenishment-verify-test-root");
const lockedReleaseId = "a".repeat(64);
const successorReleaseId = "b".repeat(64);
const lockedRenderSha256 = "c".repeat(64);
const successorRenderSha256 = "d".repeat(64);

function completedEpisode({ releaseId = lockedReleaseId, renderSha256 = lockedRenderSha256, title = "锁定标题" } = {}) {
  return {
    episodeName: "批次测试书",
    outputPath: path.join(root, "release-video.mp4"),
    scriptVersion: "v1",
    manifest: { output: { sha256: renderSha256 } },
    publish: { copy: { selectedTitle: title, description: "锁定简介" } },
    queueItem: { releaseId, renderSha256, title, description: "锁定简介" },
  };
}

function deliverySha256(result) {
  return createHash("sha256").update(formatCompletedEpisodeDelivery(result), "utf8").digest("hex");
}

function completedBatch(item) {
  return {
    batchId: "batch-verify-test",
    status: "complete",
    items: [{ book: "批次测试书", stage: "publishable", ...item }],
  };
}

function verify(batch, result) {
  return verifyReplenishmentBatch(root, {
    now: new Date("2026-08-25T02:00:00.000Z"),
    readReplenishmentBatch: () => batch,
    validateCompletedEpisode: () => result,
  });
}

const locked = completedEpisode();
const verified = verify(completedBatch({
  releaseId: lockedReleaseId,
  renderSha256: lockedRenderSha256,
  deliverySha256: deliverySha256(locked),
}), locked);
assert.equal(verified.status, "verified");
assert.equal(verified.items[0].releaseId, lockedReleaseId);
assert.equal(verified.items[0].renderSha256, lockedRenderSha256);
assert.equal(verified.items[0].deliverySha256, deliverySha256(locked));

const reissuedRelease = completedEpisode({
  releaseId: successorReleaseId,
  renderSha256: lockedRenderSha256,
  title: "同一成片的后继发布包",
});
assert.throws(
  () => verify(completedBatch({
    releaseId: lockedReleaseId,
    renderSha256: lockedRenderSha256,
    deliverySha256: deliverySha256(locked),
  }), reissuedRelease),
  new RegExp(`stale/superseded.*locked releaseId ${lockedReleaseId} differs from current ${successorReleaseId}`, "s"),
);

const successor = completedEpisode({
  releaseId: successorReleaseId,
  renderSha256: successorRenderSha256,
  title: "后继版本标题",
});
assert.throws(
  () => verify(completedBatch({
    releaseId: lockedReleaseId,
    renderSha256: lockedRenderSha256,
    deliverySha256: deliverySha256(locked),
  }), successor),
  new RegExp(`stale/superseded.*${lockedReleaseId}.*${successorReleaseId}.*${lockedRenderSha256}.*${successorRenderSha256}`, "s"),
);

assert.throws(
  () => verify(completedBatch({
    renderSha256: lockedRenderSha256,
    deliverySha256: deliverySha256(locked),
  }), locked),
  /legacy_unpinned and not verified/u,
);

assert.throws(
  () => verify(completedBatch({
    releaseId: lockedReleaseId,
    renderSha256: lockedRenderSha256,
    deliverySha256: deliverySha256(completedEpisode({ title: "已替代交付文案" })),
  }), locked),
  /stale\/superseded.*deliverySha256/u,
);

console.log("stock replenishment verify: ok");
