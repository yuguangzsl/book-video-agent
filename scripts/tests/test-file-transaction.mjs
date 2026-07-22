import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceFilesWithRollback } from "../lib/file-transaction.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-file-transaction-test-"));
try {
  const destination = path.join(root, "active.txt");
  const failedCandidate = path.join(root, "failed-candidate.txt");
  const successfulCandidate = path.join(root, "successful-candidate.txt");
  fs.writeFileSync(destination, "old");
  fs.writeFileSync(failedCandidate, "failed-new");
  assert.throws(
    () => replaceFilesWithRollback(
      [{ source: failedCandidate, destination }],
      path.join(root, "failed-backup"),
      () => { throw new Error("verification failed"); },
    ),
    /verification failed/,
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  assert.equal(fs.readFileSync(failedCandidate, "utf8"), "failed-new");

  const pairVideo = path.join(root, "active.mp4");
  const pairManifest = path.join(root, "active.manifest.json");
  const candidateVideo = path.join(root, "candidate.mp4");
  const candidateManifest = path.join(root, "candidate.manifest.json");
  fs.writeFileSync(pairVideo, "old-video");
  fs.writeFileSync(pairManifest, "old-manifest");
  fs.writeFileSync(candidateVideo, "new-video");
  fs.writeFileSync(candidateManifest, "new-manifest");
  assert.throws(
    () => replaceFilesWithRollback([
      { source: candidateVideo, destination: pairVideo },
      { source: candidateManifest, destination: pairManifest },
    ], path.join(root, "pair-backup"), () => { throw new Error("pair verification failed"); }),
    /pair verification failed/,
  );
  assert.equal(fs.readFileSync(pairVideo, "utf8"), "old-video");
  assert.equal(fs.readFileSync(pairManifest, "utf8"), "old-manifest");
  assert.equal(fs.readFileSync(candidateVideo, "utf8"), "new-video");
  assert.equal(fs.readFileSync(candidateManifest, "utf8"), "new-manifest");

  fs.writeFileSync(successfulCandidate, "new");
  replaceFilesWithRollback(
    [{ source: successfulCandidate, destination }],
    path.join(root, "successful-backup"),
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "new");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("file transaction: ok");
