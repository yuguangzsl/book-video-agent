import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveInactivePublishQueueItems,
  markPublishQueuePlatformPublished,
  requirePublishQueueItem,
  selectNextDouyinPublishQueueItem,
  upsertCompletedEpisodeIntoPublishQueue,
} from "../lib/publish-queue.mjs";
import { buildPublicationBrief, createPublicationSession } from "../lib/publication-workflow.mjs";
import { createReleasePackage } from "../lib/release-package.mjs";
import { sha256File } from "../lib/render-manifest.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-publish-queue-test-"));
const episodeName = "秋天的怀念";
const outputPath = path.join(root, "episodes", episodeName, "renders", "final.mp4");
const manifestPath = outputPath.replace(/\.mp4$/u, ".manifest.json");
const publishPath = path.join(root, "episodes", episodeName, "publish.json");

function completedResult(title, description) {
  const hash = sha256File(outputPath);
  const publish = { copy: { selectedTitle: title, description, hashtags: ["#读书", "#亲情", "#生活"] } };
  fs.writeFileSync(publishPath, `${JSON.stringify(publish)}\n`, "utf8");
  const result = {
    episodeName,
    outputPath,
    manifestPath,
    publishPath,
    manifest: {
      episode: { scriptVersion: "v1" },
      output: {
        sha256: hash,
        bytes: fs.statSync(outputPath).size,
        durationSeconds: 45,
        video: { width: 1080, height: 1920, codec: "h264" },
        audio: { codec: "aac" },
      },
    },
    publish,
  };
  return { ...result, release: createReleasePackage(root, result) };
}

try {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, "queue-video-content", "utf8");
  fs.writeFileSync(manifestPath, "{\"kind\":\"test\"}\n", "utf8");
  const firstResult = completedResult("第一版标题", "第一版简介");
  const first = upsertCompletedEpisodeIntoPublishQueue(root, firstResult, { now: new Date("2026-07-27T03:00:00.000Z") });
  assert.equal(first.queue.schemaVersion, 2);
  assert.equal(first.item.douyinStatus, "pending");
  assert.equal(first.item.xiaohongshuStatus, undefined);
  assert.equal(requirePublishQueueItem(root, firstResult).book, episodeName);
  assert.equal(selectNextDouyinPublishQueueItem(root).releaseId, first.item.releaseId);

  const revisedResult = completedResult("第二版标题", "第二版简介");
  const revised = upsertCompletedEpisodeIntoPublishQueue(root, revisedResult, { now: new Date("2026-07-27T04:00:00.000Z") });
  assert.notEqual(revised.item.releaseId, first.item.releaseId);
  assert.equal(revised.item.douyinStatus, "pending");
  assert.equal(revised.item.previousReleases[0].douyinStatus, "pending");
  assert.equal(revised.item.previousReleases[0].xiaohongshuStatus, undefined);
  const brief = buildPublicationBrief(root, { position: 1 });
  assert.equal(brief.queueStatus.douyin, "pending");
  assert.equal(brief.queueStatus.xiaohongshu, undefined);
  assert.equal(brief.platformCopy.xiaohongshu.title, "第二版标题");

  assert.throws(() => markPublishQueuePlatformPublished(root, {
    book: episodeName,
    platform: "xiaohongshu",
    expectedRenderSha256: revised.item.renderSha256,
    expectedReleaseId: revised.item.releaseId,
    proof: {},
  }), /Unsupported publication platform/u);

  const published = markPublishQueuePlatformPublished(root, {
    book: episodeName,
    platform: "douyin",
    expectedRenderSha256: revised.item.renderSha256,
    expectedReleaseId: revised.item.releaseId,
    proof: {
      url: "https://creator.douyin.com/creator-micro/content/manage",
      signal: "official content management search contains exact title",
      releaseId: revised.item.releaseId,
      renderSha256: revised.item.renderSha256,
    },
    now: new Date("2026-07-27T04:30:00.000Z"),
  });
  assert.equal(published.item.douyinStatus, "published");
  assert.equal(selectNextDouyinPublishQueueItem(root), null);
  assert.throws(() => createPublicationSession(root, { position: 1, platforms: ["douyin"] }), /douyin must be pending/u);

  const archived = archiveInactivePublishQueueItems(root, {
    reason: "Douyin publication verified",
    now: new Date("2026-07-27T05:00:00.000Z"),
  });
  assert.equal(archived.archivedCount, 1);
  assert.equal(archived.queue.items.length, 0);
  assert.equal(archived.archive.items[0].item.douyinStatus, "published");
  assert.equal(archived.archive.items[0].item.xiaohongshuStatus, undefined);

  const restored = upsertCompletedEpisodeIntoPublishQueue(root, revisedResult, { now: new Date("2026-07-27T05:05:00.000Z") });
  assert.equal(restored.item.douyinStatus, "published");
  assert.equal(selectNextDouyinPublishQueueItem(root), null);

  const queuePath = path.join(root, ".agents", "publish-queue.json");
  const staleLockPath = path.join(root, ".agents", "publish-queue.lock");
  fs.writeFileSync(staleLockPath, `${JSON.stringify({ pid: -1 })}\n`, "utf8");
  upsertCompletedEpisodeIntoPublishQueue(root, revisedResult);
  assert.equal(fs.existsSync(staleLockPath), false);
  const beforeFailure = fs.readFileSync(queuePath, "utf8");
  assert.throws(() => markPublishQueuePlatformPublished(root, {
    book: episodeName,
    platform: "douyin",
    expectedReleaseId: restored.item.releaseId,
    expectedRenderSha256: restored.item.renderSha256,
    proof: { url: "https://example.com/fake", signal: "fake" },
  }), /official host/u);
  assert.equal(fs.readFileSync(queuePath, "utf8"), beforeFailure);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("publish queue v2: ok");
