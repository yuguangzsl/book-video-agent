import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  migratePublishQueueToSchemaV2,
  normalizePublishQueueObject,
  validatePublishQueueObject,
} from "../lib/publish-queue.mjs";

const hash = "a".repeat(64);
const legacy = {
  updatedAt: "2026-09-01T00:00:00.000Z",
  items: [{
    position: 1,
    book: "测试书",
    videoPath: path.resolve("C:/tmp/test.mp4"),
    title: "标题",
    description: "简介",
    scriptVersion: "v1",
    renderSha256: hash,
    douyinStatus: "pending",
    xiaohongshuStatus: "pending",
    xiaohongshuSkip: undefined,
    createdAt: "2026-09-01T00:00:00.000Z",
  }],
};

validatePublishQueueObject(legacy);
const normalized = normalizePublishQueueObject(legacy);
assert.equal(normalized.schemaVersion, 2);
assert.equal(normalized.items[0].xiaohongshuStatus, undefined);
validatePublishQueueObject(normalized);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-queue-v2-"));
fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
fs.writeFileSync(path.join(root, ".agents", "publish-queue.json"), `${JSON.stringify(legacy, null, 2)}\n`);
const migrated = migratePublishQueueToSchemaV2(root, { now: new Date("2026-09-03T00:00:00.000Z") });
assert.equal(migrated.queue.schemaVersion, 2);
assert.equal(migrated.queue.items[0].xiaohongshuStatus, undefined);
assert.equal(fs.existsSync(migrated.backupPath), true);
const backup = JSON.parse(fs.readFileSync(migrated.backupPath, "utf8"));
assert.equal(backup.items[0].xiaohongshuStatus, "pending");
