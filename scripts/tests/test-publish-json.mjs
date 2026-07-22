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
    attempts: [],
    videoSamples: [],
    fallbackSignals: [],
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

assert.throws(
  () => validatePublishJsonObject({ ...sample, copy: { ...sample.copy, titleCandidates: ["a"] } }, "bad"),
  /titleCandidates/,
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-json-test-"));
const filePath = path.join(dir, "publish.json");
fs.writeFileSync(filePath, `${JSON.stringify(sample, null, 2)}\n`);
const parsed = readPublishJson(filePath);
assert.equal(parsed.book, "Test Book");

fs.rmSync(dir, { recursive: true, force: true });
console.log("test-publish-json: ok");
