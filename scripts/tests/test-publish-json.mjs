import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { readPublishJson, validatePublishJsonObject } from "../lib/publish-json.mjs";

const sample = {
  schemaVersion: 1,
  book: "Test Book",
  generatedAt: "2026-07-22T11:30:00+08:00",
  inputs: {
    scriptVersion: "v1",
    scriptSha256: "a".repeat(64),
    renderSha256: "b".repeat(64),
  },
  research: {
    scope: "test scope",
    popularVideoSampleStatus: "unavailable",
    notes: ["note"],
    attempts: [{
      source: "test",
      method: "test method",
      observedAt: "2026-07-22T11:25:00+08:00",
      status: "success",
      reason: "test reason",
    }],
    videoSamples: [],
    fallbackSignals: Array.from({ length: 5 }, (_, index) => ({
      source: "test",
      signal: `signal-${index}`,
      value: index,
    })),
    patterns: ["pattern"],
  },
  copy: {
    titleCandidates: ["a", "b", "c"],
    selectedTitle: "a",
    description: "desc",
    hashtags: ["#1", "#2", "#3"],
    viralityDisclaimer: "disclaimer",
  },
};

validatePublishJsonObject(sample, "sample");
validatePublishJsonObject({
  ...sample,
  copy: {
    ...sample.copy,
    platforms: {
      douyin: { title: "抖音标题" },
      xiaohongshu: {
        title: "小红书标题",
        description: "小红书简介",
        hashtags: ["#读书", "#成长", "#生活"],
      },
    },
  },
}, "platform-copy");
validatePublishJsonObject({
  ...sample,
  research: {
    ...sample.research,
    popularVideoSampleStatus: "available",
    fallbackSignals: [],
    videoSamples: Array.from({ length: 5 }, (_, index) => ({
      platform: "test",
      title: `video-${index}`,
      descriptionStatus: "missing",
      url: `https://example.com/${index}`,
      publishedAt: "2026-07-20T00:00:00.000Z",
      visibleMetrics: { likes: index + 1 },
    })),
  },
}, "video-sample");

assert.throws(
  () => validatePublishJsonObject({ ...sample, copy: { ...sample.copy, titleCandidates: ["a"] } }, "bad"),
  /titleCandidates/,
);
assert.throws(
  () => validatePublishJsonObject({
    ...sample,
    research: { ...sample.research, fallbackSignals: sample.research.fallbackSignals.slice(0, 4) },
  }, "bad"),
  /at least 5 fallback signals/,
);
assert.throws(
  () => validatePublishJsonObject({ ...sample, research: { ...sample.research, attempts: [] } }, "bad"),
  /attempts must be a non-empty array/,
);
assert.throws(
  () => validatePublishJsonObject({ ...sample, copy: { ...sample.copy, selectedTitle: "missing" } }, "bad"),
  /must be one of/,
);
assert.throws(
  () => validatePublishJsonObject({
    ...sample,
    copy: {
      ...sample.copy,
      platforms: {
        xiaohongshu: { title: "超".repeat(21) },
      },
    },
  }, "bad"),
  /must not exceed 20 characters/,
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-json-test-"));
const filePath = path.join(dir, "publish.json");
fs.writeFileSync(filePath, `${JSON.stringify(sample, null, 2)}\n`);
const parsed = readPublishJson(filePath);
assert.equal(parsed.book, "Test Book");

fs.rmSync(dir, { recursive: true, force: true });
console.log("test-publish-json: ok");
