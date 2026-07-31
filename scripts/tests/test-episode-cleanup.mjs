import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupEpisodes } from "../lib/episode-cleanup.mjs";
import { readGeneratedTitleIndex } from "../lib/generated-title-index.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-episode-cleanup-test-"));
const now = Date.parse("2026-07-27T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;

function createEpisode(name, ageDays) {
  const episodeDir = path.join(root, "episodes", name);
  const videoPath = path.join(episodeDir, "renders", "final.mp4");
  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  fs.writeFileSync(path.join(episodeDir, "brief.json"), `${JSON.stringify({ display_title: name })}\n`);
  fs.writeFileSync(videoPath, "video");
  const timestamp = new Date(now - ageDays * day);
  fs.utimesSync(videoPath, timestamp, timestamp);
  return episodeDir;
}

try {
  const oldEpisode = createEpisode("旧书", 8);
  const newEpisode = createEpisode("新书", 6);
  const activeEpisode = createEpisode("活动书", 9);
  const unknownEpisode = path.join(root, "episodes", "年龄未知");
  fs.mkdirSync(unknownEpisode, { recursive: true });
  const outside = path.join(root, "keep.txt");
  fs.writeFileSync(outside, "keep");
  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents", "publish-queue.json"), `${JSON.stringify({
    updatedAt: new Date(now).toISOString(),
    items: [{
      position: 1,
      book: "活动书",
      videoPath: path.join(activeEpisode, "renders", "final.mp4"),
      title: "标题",
      description: "简介",
      scriptVersion: "v1",
      renderSha256: "a".repeat(64),
      douyinStatus: "pending",
      xiaohongshuStatus: "published",
      createdAt: new Date(now - 9 * day).toISOString(),
    }],
  }, null, 2)}\n`, "utf8");

  const dryRun = cleanupEpisodes(root, { now, apply: false });
  assert.equal(dryRun.items.find((item) => item.episode === "旧书").eligible, true);
  assert.equal(dryRun.items.find((item) => item.episode === "新书").eligible, false);
  assert.equal(dryRun.items.find((item) => item.episode === "活动书").reason, "active");
  assert.equal(dryRun.items.find((item) => item.episode === "年龄未知").reason, "untrusted-age");
  assert.equal(fs.existsSync(oldEpisode), true);
  assert.deepEqual(readGeneratedTitleIndex(root), []);

  const applied = cleanupEpisodes(root, { now, apply: true });
  assert.deepEqual(applied.removed.map((item) => item.title), ["旧书"]);
  assert.equal(fs.existsSync(oldEpisode), false);
  assert.equal(fs.existsSync(newEpisode), true);
  assert.equal(fs.existsSync(activeEpisode), true);
  assert.equal(fs.existsSync(unknownEpisode), true);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.deepEqual(readGeneratedTitleIndex(root), ["旧书"]);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("episode cleanup: ok");
