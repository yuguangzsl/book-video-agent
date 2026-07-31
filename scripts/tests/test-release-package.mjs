import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256File } from "../lib/render-manifest.mjs";
import {
  createReleasePackage,
  readReleasePackage,
} from "../lib/release-package.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-release-package-test-"));
const episodeName = "release-test";
const episodeDir = path.join(root, "episodes", episodeName);
const rendersDir = path.join(episodeDir, "renders");
const outputPath = path.join(rendersDir, "final.mp4");
const manifestPath = path.join(rendersDir, "final.manifest.json");
const publishPath = path.join(episodeDir, "publish.json");

try {
  fs.mkdirSync(rendersDir, { recursive: true });
  fs.writeFileSync(outputPath, "immutable-video-content", "utf8");
  fs.writeFileSync(manifestPath, "{\"kind\":\"test\"}\n", "utf8");
  fs.writeFileSync(publishPath, "{\"kind\":\"test\"}\n", "utf8");
  const renderSha256 = sha256File(outputPath);
  const commonTitle = "这是一个超过小红书二十字但没有超过抖音三十字的标题";
  const completed = {
    episodeName,
    outputPath,
    manifestPath,
    publishPath,
    manifest: {
      episode: { scriptVersion: "v1" },
      output: {
        sha256: renderSha256,
        bytes: fs.statSync(outputPath).size,
        durationSeconds: 42.5,
        video: { width: 1080, height: 1920, codec: "h264" },
        audio: { codec: "aac" },
      },
    },
    publish: {
      copy: {
        selectedTitle: commonTitle,
        description: "release description",
        hashtags: ["#读书", "#成长", "#生活"],
      },
    },
  };

  const first = createReleasePackage(root, completed, {
    now: new Date("2026-07-30T06:00:00.000Z"),
  });
  assert.match(first.release.releaseId, /^[a-f0-9]{64}$/u);
  assert.equal(first.release.video.sha256, renderSha256);
  assert.equal(first.release.publication.platforms.douyin.title, commonTitle);
  assert.equal(first.release.publication.platforms.douyin.titleSource, "common");
  assert.equal([...first.release.publication.platforms.xiaohongshu.title].length, 20);
  assert.equal(first.release.publication.platforms.xiaohongshu.titleSource, "common-truncated");
  assert.notEqual(path.resolve(first.videoPath), path.resolve(outputPath));

  const second = createReleasePackage(root, completed);
  assert.equal(second.release.releaseId, first.release.releaseId);
  assert.equal(second.videoPath, first.videoPath);

  fs.renameSync(outputPath, `${outputPath}.old`);
  fs.writeFileSync(outputPath, "new-active-render", "utf8");
  const reread = readReleasePackage(root, first.manifestPortablePath);
  assert.equal(reread.release.video.sha256, renderSha256);

  const changedCopy = {
    ...completed,
    outputPath: `${outputPath}.old`,
    publish: {
      copy: {
        ...completed.publish.copy,
        platforms: {
          xiaohongshu: { title: "明确的小红书标题" },
        },
      },
    },
  };
  const third = createReleasePackage(root, changedCopy, {
    now: new Date("2026-07-30T07:00:00.000Z"),
  });
  assert.notEqual(third.release.releaseId, first.release.releaseId);
  assert.equal(third.release.video.sha256, first.release.video.sha256);
  assert.equal(third.release.publication.platforms.xiaohongshu.title, "明确的小红书标题");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("release package: ok");
