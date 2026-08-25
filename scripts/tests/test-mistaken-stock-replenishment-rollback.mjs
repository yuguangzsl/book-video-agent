import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupEpisodes } from "../lib/episode-cleanup.mjs";
import {
  createProductionLedger,
  readProductionLedger,
  writeProductionLedger,
} from "../lib/production-ledger.mjs";
import { readPublishQueue, readPublishQueueArchive } from "../lib/publish-queue.mjs";
import { readReplenishmentBatch } from "../lib/replenishment-batch.mjs";
import { createReleasePackage } from "../lib/release-package.mjs";
import { sha256File } from "../lib/render-manifest.mjs";

const repositoryRoot = process.cwd();
const rollbackCli = path.join(repositoryRoot, "scripts", "rollback-mistaken-stock-replenishment.mjs");
const inventoryCli = path.join(repositoryRoot, "scripts", "inspect-publish-queue.mjs");
const productionCli = path.join(repositoryRoot, "scripts", "inspect-production-state.mjs");
const stockCli = path.join(repositoryRoot, "scripts", "manage-stock-replenishment.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-mistaken-stock-rollback-test-"));
const now = new Date("2026-08-25T06:00:00.000Z");
const oldVideoDate = new Date("2026-08-10T06:00:00.000Z");

function run(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function parseResult(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function createCompletedEpisode(book, content, position) {
  const episodeDirectory = path.join(root, "episodes", book);
  const rendersDirectory = path.join(episodeDirectory, "renders");
  const outputPath = path.join(rendersDirectory, "final.mp4");
  const manifestPath = path.join(rendersDirectory, "final.manifest.json");
  const publishPath = path.join(episodeDirectory, "publish.json");
  fs.mkdirSync(rendersDirectory, { recursive: true });
  fs.writeFileSync(path.join(episodeDirectory, "brief.json"), `${JSON.stringify({ display_title: book, author: "测试作者" })}\n`, "utf8");
  fs.writeFileSync(outputPath, content, "utf8");
  fs.utimesSync(outputPath, oldVideoDate, oldVideoDate);
  fs.writeFileSync(manifestPath, "{\"kind\":\"test-render\"}\n", "utf8");
  const publish = {
    copy: {
      selectedTitle: `${book} 标题`,
      description: `${book} 简介`,
      hashtags: ["#读书", "#测试", "#库存"],
    },
  };
  fs.writeFileSync(publishPath, `${JSON.stringify(publish, null, 2)}\n`, "utf8");
  const renderSha256 = sha256File(outputPath);
  const completed = {
    episodeName: book,
    outputPath,
    manifestPath,
    publishPath,
    manifest: {
      episode: { scriptVersion: "v1" },
      output: {
        sha256: renderSha256,
        bytes: fs.statSync(outputPath).size,
        durationSeconds: 45,
        video: { width: 1080, height: 1920, codec: "h264" },
        audio: { codec: "aac" },
      },
    },
    publish,
  };
  const release = createReleasePackage(root, completed, { now });
  return {
    batchItem: {
      book,
      stage: "publishable",
      finalizedAt: now.toISOString(),
      releaseId: release.release.releaseId,
      renderSha256,
      deliverySha256: position === 1 ? "a".repeat(64) : "b".repeat(64),
    },
    queueItem: {
      position,
      book,
      videoPath: outputPath,
      title: publish.copy.selectedTitle,
      description: publish.copy.description,
      scriptVersion: "v1",
      renderSha256,
      releaseId: release.release.releaseId,
      releaseManifestPath: release.manifestPortablePath,
      douyinStatus: "pending",
      xiaohongshuStatus: "pending",
      createdAt: now.toISOString(),
    },
  };
}

try {
  const first = createCompletedEpisode("误入库甲", "first immutable release", 1);
  const second = createCompletedEpisode("误入库乙", "second immutable release", 2);
  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  writeProductionLedger(root, createProductionLedger({ now }), { now });
  fs.writeFileSync(path.join(root, ".agents", "publish-queue.json"), `${JSON.stringify({
    updatedAt: now.toISOString(),
    items: [first.queueItem, second.queueItem],
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(root, ".agents", "stock-replenishment.json"), `${JSON.stringify({
    schemaVersion: 1,
    batchId: "mistaken-stock-batch",
    status: "complete",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    sampleBook: first.batchItem.book,
    items: [first.batchItem, second.batchItem],
  }, null, 2)}\n`, "utf8");

  const originalQueue = fs.readFileSync(path.join(root, ".agents", "publish-queue.json"), "utf8");
  const mismatchedQueue = JSON.parse(originalQueue);
  mismatchedQueue.items[0].renderSha256 = "f".repeat(64);
  fs.writeFileSync(path.join(root, ".agents", "publish-queue.json"), `${JSON.stringify(mismatchedQueue, null, 2)}\n`, "utf8");
  const mismatch = run(rollbackCli, ["--dry-run"]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /renderSha256 does not match/u);
  assert.equal(readPublishQueue(root).items[0].renderSha256, "f".repeat(64));
  fs.writeFileSync(path.join(root, ".agents", "publish-queue.json"), originalQueue, "utf8");

  const dryRun = parseResult(run(rollbackCli, ["--dry-run"]));
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.changed, false);
  assert.equal(dryRun.archivedCount, 2);
  assert.equal(readPublishQueue(root).items.length, 2);
  assert.equal(readReplenishmentBatch(root).status, "complete");
  assert.equal(fs.existsSync(path.join(root, ".agents", "publish-queue.archive.json")), false);

  const missingConfirmation = run(rollbackCli, ["--apply"]);
  assert.notEqual(missingConfirmation.status, 0);
  assert.match(missingConfirmation.stderr, /confirm-mistaken-stock-rollback/u);
  assert.equal(readPublishQueue(root).items.length, 2);

  const ledgerBeforeApply = fs.readFileSync(path.join(root, ".agents", "production-ledger.json"), "utf8");
  const applied = parseResult(run(rollbackCli, ["--apply", "--confirm-mistaken-stock-rollback"]));
  assert.equal(applied.apply, true);
  assert.equal(applied.changed, true);
  assert.equal(applied.archivedCount, 2);
  assert.equal(readPublishQueue(root).items.length, 0);
  const archive = readPublishQueueArchive(root);
  assert.equal(archive.items.length, 2);
  for (const entry of archive.items) {
    assert.equal(entry.reason, "mistaken-stock-replenishment");
    assert.equal(entry.correction.rollbackId, applied.rollbackId);
    assert.equal(entry.item.douyinStatus, "pending");
    assert.equal(entry.item.xiaohongshuStatus, "pending");
    assert.equal(entry.item.douyinPublication, undefined);
    assert.equal(entry.item.xiaohongshuPublication, undefined);
  }
  const retired = readReplenishmentBatch(root, { required: true });
  assert.equal(retired.status, "archived");
  assert.equal(retired.retirement.rollbackId, applied.rollbackId);
  assert.equal(retired.retirement.archivedQueueReleases.length, 2);
  assert.equal(fs.existsSync(applied.rollbackRecordPath), true);
  assert.equal(fs.readFileSync(path.join(root, ".agents", "production-ledger.json"), "utf8"), ledgerBeforeApply);
  assert.doesNotThrow(() => readProductionLedger(root, { required: true }));
  assert.equal(fs.existsSync(path.join(root, ".agents", "publish-queue.lock")), false);
  assert.equal(fs.existsSync(path.join(root, ".agents", "stock-replenishment.lock")), false);

  const stockStatus = parseResult(run(stockCli, ["status"]));
  assert.equal(stockStatus.status, "archived");
  const stockVerify = run(stockCli, ["verify"]);
  assert.notEqual(stockVerify.status, 0);
  assert.match(stockVerify.stderr, /not complete/u);

  const inventory = parseResult(run(inventoryCli, ["--verify"]));
  assert.equal(inventory.count, 0);
  const production = parseResult(run(productionCli, ["--verify"]));
  assert.equal(production.queueItems, 0);

  const cleanup = cleanupEpisodes(root, { now: now.getTime(), apply: false });
  for (const book of [first.batchItem.book, second.batchItem.book]) {
    const entry = cleanup.items.find((item) => item.episode === book);
    assert.equal(entry.eligible, false);
    assert.equal(entry.reason, "protected-mistaken-stock-replenishment-archive");
  }
  const cleanupApplied = cleanupEpisodes(root, { now: now.getTime(), apply: true });
  assert.equal(cleanupApplied.removed.length, 0);
  assert.equal(fs.existsSync(path.join(root, "episodes", first.batchItem.book)), true);
  assert.equal(fs.existsSync(path.join(root, "episodes", second.batchItem.book)), true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("mistaken stock replenishment rollback: ok");
