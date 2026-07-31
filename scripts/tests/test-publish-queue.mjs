import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  markPublishQueuePlatformPublished,
  readPublishQueue,
  requirePublishQueueItem,
  upsertCompletedEpisodeIntoPublishQueue,
} from "../lib/publish-queue.mjs";
import {
  buildPublicationBrief,
  createPublicationSession,
} from "../lib/publication-workflow.mjs";
import { createReleasePackage } from "../lib/release-package.mjs";
import { sha256File } from "../lib/render-manifest.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-publish-queue-test-"));
const outputPath = path.join(root, "episodes", "秋天的怀念(轻经典)", "renders", "final.mp4");
const manifestPath = outputPath.replace(/\.mp4$/u, ".manifest.json");
const publishPath = path.join(root, "episodes", "秋天的怀念(轻经典)", "publish.json");

function completedResult(title, description) {
  const hash = sha256File(outputPath);
  const publish = {
    copy: {
      selectedTitle: title,
      description,
      hashtags: ["#读书", "#亲情", "#生活"],
    },
  };
  fs.writeFileSync(publishPath, `${JSON.stringify(publish)}\n`, "utf8");
  const result = {
    episodeName: "秋天的怀念(轻经典)",
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
  const result = completedResult(
    "那句“以后吧”，后来真的就没有以后了",
    "中文简介必须按 UTF-8 原样往返。",
  );
  const hash = result.manifest.output.sha256;
  const first = upsertCompletedEpisodeIntoPublishQueue(root, result, {
    now: new Date("2026-07-27T03:00:00.000Z"),
  });
  assert.equal(first.item.position, 1);
  assert.equal(first.item.title, result.publish.copy.selectedTitle);
  assert.equal(first.item.description, result.publish.copy.description);
  assert.equal(first.item.douyinStatus, "pending");
  assert.equal(requirePublishQueueItem(root, result).book, result.episodeName);
  assert.equal(readPublishQueue(root).items[0].title, result.publish.copy.selectedTitle);

  const queuePath = path.join(root, ".agents", "publish-queue.json");
  const edited = readPublishQueue(root);
  delete edited.items[0].releaseId;
  delete edited.items[0].releaseManifestPath;
  edited.items[0].douyinStatus = "published";
  fs.writeFileSync(queuePath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");
  const second = upsertCompletedEpisodeIntoPublishQueue(root, result, {
    now: new Date("2026-07-27T04:00:00.000Z"),
  });
  assert.equal(second.item.position, 1);
  assert.equal(second.item.douyinStatus, "published");
  assert.equal(second.item.releaseId, first.item.releaseId);
  assert.equal(second.item.previousReleases, undefined);
  assert.equal(fs.existsSync(`${queuePath}.${process.pid}.tmp`), false);

  const revised = completedResult("更新后的中文标题", "更新后的中文简介。");
  const revisedQueue = upsertCompletedEpisodeIntoPublishQueue(root, revised, {
    now: new Date("2026-07-27T04:30:00.000Z"),
  });
  assert.notEqual(revisedQueue.item.releaseId, first.item.releaseId);
  assert.equal(revisedQueue.item.renderSha256, first.item.renderSha256);
  assert.equal(revisedQueue.item.douyinStatus, "pending");
  assert.equal(revisedQueue.item.xiaohongshuStatus, "pending");
  assert.equal(revisedQueue.item.previousReleases.length, 1);
  assert.equal(revisedQueue.item.previousReleases[0].douyinStatus, "published");
  const brief = buildPublicationBrief(root, { position: 1 });
  assert.equal(brief.releaseId, revised.release.release.releaseId);
  assert.equal(brief.videoPath, revised.release.videoPath);
  assert.equal(brief.platformCopy.douyin.title, "更新后的中文标题");
  assert.equal(brief.platformCopy.xiaohongshu.title, "更新后的中文标题");

  const douyin = markPublishQueuePlatformPublished(root, {
    book: revised.episodeName,
    platform: "douyin",
    expectedRenderSha256: hash,
    proof: {
      url: "https://creator.douyin.com/creator-micro/content/manage",
      signal: "official content management search contains exact title",
      releaseId: revised.release.release.releaseId,
      renderSha256: hash,
    },
    now: new Date("2026-07-27T04:45:00.000Z"),
  });
  assert.equal(douyin.item.douyinPublication.releaseId, revised.release.release.releaseId);
  assert.equal(douyin.item.douyinPublication.renderSha256, hash);

  const xiaohongshu = markPublishQueuePlatformPublished(root, {
    book: result.episodeName,
    platform: "xiaohongshu",
    expectedRenderSha256: hash,
    proof: {
      url: "https://creator.xiaohongshu.com/publish/success?noteId=123",
      signal: "official publish success page",
      workId: "123",
      releaseId: revised.release.release.releaseId,
      renderSha256: hash,
    },
    now: new Date("2026-07-27T05:00:00.000Z"),
  });
  assert.equal(xiaohongshu.changed, true);
  assert.equal(xiaohongshu.item.xiaohongshuStatus, "published");
  assert.equal(xiaohongshu.item.douyinStatus, "published");
  assert.equal(xiaohongshu.item.xiaohongshuPublication.workId, "123");

  const browserPublisherRoot = path.join(root, ".agents", "browser-publisher");
  assert.throws(
    () => createPublicationSession(root, {
      position: 1,
      platforms: ["douyin", "xiaohongshu"],
    }),
    /douyin must be pending/u,
  );
  assert.equal(
    fs.existsSync(browserPublisherRoot),
    false,
    "an exhausted queue must not create a browser publication session",
  );
  assert.throws(
    () => buildPublicationBrief(root, { position: 999 }),
    /Expected exactly one publication queue item, found 0/u,
  );

  const idempotent = markPublishQueuePlatformPublished(root, {
    book: result.episodeName,
    platform: "xiaohongshu",
    expectedRenderSha256: hash,
    proof: {
      url: "https://creator.xiaohongshu.com/publish/success?noteId=123",
      signal: "official publish success page",
      workId: "123",
      releaseId: revised.release.release.releaseId,
      renderSha256: hash,
    },
    now: new Date("2026-07-27T05:01:00.000Z"),
  });
  assert.equal(idempotent.changed, false);

  const staleLockPath = path.join(root, ".agents", "publish-queue.lock");
  fs.writeFileSync(staleLockPath, `${JSON.stringify({ pid: -1, startedAt: "2026-07-27T00:00:00.000Z" })}\n`, "utf8");
  const recovered = upsertCompletedEpisodeIntoPublishQueue(root, revised, {
    now: new Date("2026-07-27T05:02:00.000Z"),
  });
  assert.equal(recovered.item.releaseId, revised.release.release.releaseId);
  assert.equal(fs.existsSync(staleLockPath), false);

  const beforeFailure = fs.readFileSync(queuePath, "utf8");
  assert.throws(
    () => markPublishQueuePlatformPublished(root, {
      book: result.episodeName,
      platform: "douyin",
      expectedRenderSha256: hash,
      proof: {
        url: "https://example.com/fake-success",
        signal: "untrusted page",
      },
    }),
    /official host/,
  );
  assert.equal(fs.readFileSync(queuePath, "utf8"), beforeFailure);
  assert.throws(
    () => upsertCompletedEpisodeIntoPublishQueue(root, {
      ...result,
      manifest: { ...result.manifest, output: { sha256: "invalid" } },
      release: revised.release,
    }),
    /renderSha256 must be a sha256 hex string/,
  );
  assert.equal(fs.readFileSync(queuePath, "utf8"), beforeFailure);
  assert.equal(fs.existsSync(path.join(root, ".agents", "publish-queue.lock")), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("publish queue: ok");
