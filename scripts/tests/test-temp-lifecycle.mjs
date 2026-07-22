import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TEMP_METADATA_FILENAME,
  createTempWorkspace,
  pruneKnownAtomicTempFiles,
  pruneExpiredTempWorkspaces,
  removeTempWorkspace,
  requireManagedTempWorkspace,
  updateTempWorkspace,
} from "../lib/temp-lifecycle.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-temp-lifecycle-test-"));
const hour = 60 * 60 * 1000;
const start = Date.parse("2026-07-17T00:00:00.000Z");

try {
  const expired = createTempWorkspace(root, { kind: "preview", label: "expired", now: start, retentionHours: 1 });
  const active = createTempWorkspace(root, { kind: "render", label: "active", now: start, retentionHours: 4 });
  assert.equal(fs.existsSync(path.join(active, TEMP_METADATA_FILENAME)), true);
  assert.equal(requireManagedTempWorkspace(root, active), active);

  const unmanaged = path.join(root, "tmp", "user-notes");
  fs.mkdirSync(unmanaged, { recursive: true });
  fs.writeFileSync(path.join(unmanaged, "keep.txt"), "keep");

  const dryRun = pruneExpiredTempWorkspaces(root, { now: start + 2 * hour, dryRun: true });
  assert.equal(dryRun.removed.includes(path.basename(expired)), true);
  assert.equal(fs.existsSync(expired), true);

  const pruned = pruneExpiredTempWorkspaces(root, { now: start + 2 * hour });
  assert.equal(pruned.removed.includes(path.basename(expired)), true);
  assert.equal(pruned.retained.includes(path.basename(active)), true);
  assert.equal(pruned.unmanaged.includes("user-notes"), true);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(unmanaged), true);

  const metadata = updateTempWorkspace(root, active, {
    status: "failed",
    now: start + 2 * hour,
    retentionHours: 72,
    details: { stage: "render" },
  });
  assert.equal(metadata.status, "failed");
  assert.equal(metadata.details.stage, "render");

  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const atomicTemp = path.join(dataDir, "book-pipeline.csv.2147483647.tmp");
  const unknownTemp = path.join(dataDir, "notes.tmp");
  const liveAtomicTemp = path.join(root, `.env.${process.pid}.tmp`);
  const episodeAudioDir = path.join(root, "episodes", "测试书", "audio");
  const timingAtomicTemp = path.join(episodeAudioDir, "body-timings.json.2147483646.tmp");
  fs.mkdirSync(episodeAudioDir, { recursive: true });
  fs.writeFileSync(atomicTemp, "temporary");
  fs.writeFileSync(unknownTemp, "keep");
  fs.writeFileSync(liveAtomicTemp, "active");
  fs.writeFileSync(timingAtomicTemp, "temporary timing");
  fs.utimesSync(atomicTemp, new Date(start), new Date(start));
  fs.utimesSync(liveAtomicTemp, new Date(start), new Date(start));
  fs.utimesSync(timingAtomicTemp, new Date(start), new Date(start));
  const atomicResult = pruneKnownAtomicTempFiles(root, { now: start + 25 * hour, olderThanHours: 24 });
  assert.equal(atomicResult.removed.includes(path.join("data", path.basename(atomicTemp))), true);
  assert.equal(atomicResult.removed.includes(path.join("episodes", "测试书", "audio", path.basename(timingAtomicTemp))), true);
  assert.equal(atomicResult.retained.includes(path.basename(liveAtomicTemp)), true);
  assert.equal(fs.existsSync(atomicTemp), false);
  assert.equal(fs.existsSync(timingAtomicTemp), false);
  assert.equal(fs.existsSync(unknownTemp), true);
  assert.equal(fs.existsSync(liveAtomicTemp), true);

  assert.throws(() => requireManagedTempWorkspace(root, unmanaged), /not managed/u);
  removeTempWorkspace(root, active);
  assert.equal(fs.existsSync(active), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("temp lifecycle tests: ok");
