#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./lib/json.mjs";
import { writeFileAtomically } from "./lib/filesystem.mjs";
import { manualXiaohongshuVerificationStatusPath } from "./lib/manual-xiaohongshu-verification.mjs";
import { readPublishQueue, reopenXiaohongshuFalsePositive } from "./lib/publish-queue.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
}

const confirm = args.includes("--confirm-false-positive");
const position = Number(valueAfter("--position"));
const releaseId = valueAfter("--release-id").toLowerCase();
const renderSha256 = valueAfter("--sha256").toLowerCase();
const reason = valueAfter("--reason");
const valueArgs = new Set(["--position", "--release-id", "--sha256", "--reason"]);
const allowedFlags = new Set(["--confirm-false-positive", ...valueArgs]);
const malformed = args.some((arg, index) => (
  index > 0 && valueArgs.has(args[index - 1]) ? false : !allowedFlags.has(arg)
));

if (!confirm || !Number.isInteger(position) || position <= 0 || !releaseId || !renderSha256 || !reason || malformed) {
  console.error(
    'Usage: node scripts/reopen-xiaohongshu-false-positive.mjs --position <n> --release-id <sha256> --sha256 <sha256> --confirm-false-positive --reason "<reason>"',
  );
  process.exit(1);
}

const current = readPublishQueue(ROOT, { required: true });
const matchingItems = current.items.filter((item) => item.position === position);
if (matchingItems.length !== 1) {
  throw new Error(`Expected exactly one publication queue item at position ${position}, found ${matchingItems.length}`);
}
const currentItem = matchingItems[0];
if (currentItem.releaseId !== releaseId || String(currentItem.renderSha256).toLowerCase() !== renderSha256) {
  throw new Error("Refusing to reopen a queue item with a different release or render hash");
}
let result;
if (currentItem.xiaohongshuStatus === "published") {
  result = reopenXiaohongshuFalsePositive(ROOT, {
    position,
    expectedReleaseId: releaseId,
    expectedRenderSha256: renderSha256,
    reason,
  });
} else {
  const retraction = currentItem.xiaohongshuPublicationRetractions?.at(-1);
  if (
    currentItem.xiaohongshuStatus !== "pending"
    || currentItem.xiaohongshuPublication !== undefined
    || retraction?.releaseId !== releaseId
    || retraction?.renderSha256 !== renderSha256
  ) {
    throw new Error("Xiaohongshu queue item is not a resumable false-positive reopen");
  }
  result = {
    changed: false,
    item: currentItem,
    filePath: path.join(ROOT, ".agents", "publish-queue.json"),
    retraction,
  };
}
const statusPath = manualXiaohongshuVerificationStatusPath(ROOT, releaseId);
let verificationStatusUpdated = false;
if (fs.existsSync(statusPath)) {
  const previous = readJsonFile(statusPath);
  if (previous.releaseId !== releaseId || previous.renderSha256 !== renderSha256) {
    throw new Error(`Refusing to retract a mismatched Xiaohongshu verification status: ${statusPath}`);
  }
  writeFileAtomically(statusPath, `${JSON.stringify({
    ...previous,
    ...(Number(previous.queuePosition) !== position ? { previousQueuePosition: previous.queuePosition } : {}),
    queuePosition: position,
    status: "retracted_false_positive",
    queueUpdated: false,
    retractedAt: result.retraction.retractedAt,
    retractionReason: reason,
    action: "Run publish:xiaohongshu for the same queue item; do not reuse this proof",
  }, null, 2)}\n`, { encoding: "utf8" });
  verificationStatusUpdated = true;
}

process.stdout.write(`${JSON.stringify({
  changed: result.changed,
  position: result.item.position,
  book: result.item.book,
  releaseId: result.item.releaseId,
  renderSha256: result.item.renderSha256,
  douyinStatus: result.item.douyinStatus,
  xiaohongshuStatus: result.item.xiaohongshuStatus,
  queuePath: result.filePath,
  verificationStatusPath: statusPath,
  verificationStatusUpdated,
}, null, 2)}\n`);
