import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeManifestFile } from "../lib/render-manifest.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-manifest-test-"));
const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-manifest-external-"));

try {
  const projectFile = path.join(root, "episodes", "book", "script.csv");
  const externalFile = path.join(externalRoot, "music.mp3");
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, "version,order,text\nv1,1,test\n");
  fs.writeFileSync(externalFile, "audio");

  const projectRecord = describeManifestFile(root, projectFile);
  assert.equal(projectRecord.file, "episodes/book/script.csv");
  assert.equal(projectRecord.location, "project");
  assert.match(projectRecord.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(projectRecord.bytes, fs.statSync(projectFile).size);

  const externalRecord = describeManifestFile(root, externalFile);
  assert.equal(externalRecord.file, "music.mp3");
  assert.equal(externalRecord.location, "external");
  assert.equal(externalRecord.file.includes(externalRoot), false);

  const candidateOutput = path.join(root, "tmp", "candidate.mp4");
  const finalOutput = path.join(root, "episodes", "book", "renders", "final.mp4");
  fs.mkdirSync(path.dirname(candidateOutput), { recursive: true });
  fs.writeFileSync(candidateOutput, "video");
  const outputRecord = describeManifestFile(root, candidateOutput, { referencePath: finalOutput });
  assert.equal(outputRecord.file, "episodes/book/renders/final.mp4");
  assert.equal(outputRecord.location, "project");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(externalRoot, { recursive: true, force: true });
}

console.log("render manifest tests: ok");
