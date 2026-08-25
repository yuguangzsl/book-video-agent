#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatCompletedEpisodeDelivery,
  validateCompletedEpisode,
} from "./lib/episode-checks.mjs";
import {
  beginReplenishmentBatch,
  readReplenishmentBatch,
} from "./lib/replenishment-batch.mjs";

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeSha256(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  assert(/^[a-f0-9]{64}$/u.test(normalized), `${label} must be a sha256 hex string`);
  return normalized;
}

function currentItemSnapshot(result, deliveryFormatter) {
  const releaseId = normalizeSha256(result.queueItem?.releaseId, "Current immutable releaseId");
  const renderSha256 = normalizeSha256(result.manifest?.output?.sha256, "Current renderSha256");
  const deliverySha256 = createHash("sha256")
    .update(deliveryFormatter(result), "utf8")
    .digest("hex");
  return { releaseId, renderSha256, deliverySha256 };
}

function assertBatchItemMatchesCurrent(batch, item, current) {
  if (!item.releaseId) {
    throw new Error(
      `Stock replenishment batch ${batch.batchId} item ${item.book} is legacy_unpinned and not verified: missing locked releaseId`,
    );
  }
  const locked = {
    releaseId: normalizeSha256(item.releaseId, `Batch item ${item.book} releaseId`),
    renderSha256: normalizeSha256(item.renderSha256, `Batch item ${item.book} renderSha256`),
    deliverySha256: normalizeSha256(item.deliverySha256, `Batch item ${item.book} deliverySha256`),
  };
  const mismatches = Object.entries(locked)
    .filter(([field, value]) => value !== current[field])
    .map(([field, value]) => `locked ${field} ${value} differs from current ${current[field]}`);
  if (mismatches.length > 0) {
    throw new Error(
      `Stock replenishment batch ${batch.batchId} item ${item.book} is stale/superseded and not verified: ${mismatches.join("; ")}`,
    );
  }
  return locked;
}

export function verifyReplenishmentBatch(root, options = {}) {
  const readBatch = options.readReplenishmentBatch || readReplenishmentBatch;
  const validateEpisode = options.validateCompletedEpisode || validateCompletedEpisode;
  const deliveryFormatter = options.formatCompletedEpisodeDelivery || formatCompletedEpisodeDelivery;
  const batch = readBatch(root, { required: true });
  if (batch.status !== "complete") {
    throw new Error(`Stock replenishment batch ${batch.batchId} is not complete`);
  }
  const items = batch.items.map((item) => {
    const result = validateEpisode(root, item.book, "", {
      requirePublish: true,
      requireQueue: true,
    });
    const current = currentItemSnapshot(result, deliveryFormatter);
    assertBatchItemMatchesCurrent(batch, item, current);
    return {
      book: result.episodeName,
      videoPath: result.outputPath,
      title: result.publish.copy.selectedTitle,
      description: result.publish.copy.description,
      scriptVersion: result.scriptVersion,
      ...current,
    };
  });
  return {
    batchId: batch.batchId,
    status: "verified",
    verifiedAt: options.now instanceof Date ? options.now.toISOString() : new Date().toISOString(),
    count: items.length,
    items,
  };
}

function runCli() {
  const ROOT = process.cwd();
  const [action, ...args] = process.argv.slice(2);
  if (action === "begin") {
    print(beginReplenishmentBatch(ROOT, args));
  } else if (action === "status") {
    print(readReplenishmentBatch(ROOT, { required: true }));
  } else if (action === "verify") {
    print(verifyReplenishmentBatch(ROOT));
  } else {
    console.error("Usage: node scripts/manage-stock-replenishment.mjs begin <sample-book> [book...]");
    console.error("       node scripts/manage-stock-replenishment.mjs status");
    console.error("       node scripts/manage-stock-replenishment.mjs verify");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
