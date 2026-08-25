import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_PUBLICATION_ATTEMPTS,
  publicationSessionSummary,
  readPublicationConfirmation,
  readPublicationSession,
  updatePublicationPlatform,
  validatePublicationSession,
  writePublicationConfirmation,
} from "../lib/publication-workflow.mjs";
import {
  createProductionLedger,
  recordProductionRelease,
  writeProductionLedger,
} from "../lib/production-ledger.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-publication-workflow-test-"));
const publisherRoot = path.join(root, ".agents", "browser-publisher");
const sessionsRoot = path.join(publisherRoot, "sessions");
const sessionId = "session-1";
const hash = "b".repeat(64);
const releaseId = "a".repeat(64);
const now = "2026-07-30T03:00:00.000Z";
const session = {
  schemaVersion: 1,
  id: sessionId,
  createdAt: now,
  updatedAt: now,
  requestedPlatforms: ["douyin"],
  accounts: {
    douyin: { name: "account", id: "123" },
  },
  brief: {
    queuePosition: 5,
    book: "book",
    videoPath: path.join(root, "video.mp4"),
    releaseId,
    renderSha256: hash,
  },
  platforms: {
    douyin: { status: "ready", updatedAt: now },
    xiaohongshu: { status: "not_requested", updatedAt: now },
  },
};

try {
  const ledger = createProductionLedger({ now });
  recordProductionRelease(ledger, {
    releaseId,
    renderSha256: hash,
    displayTitle: "book",
    episodeName: "book",
    scriptVersion: "v1",
    manifestPath: "episodes/book/releases/release.json",
    createdAt: now,
  }, { now });
  writeProductionLedger(root, ledger, { now });
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionsRoot, `${sessionId}.json`), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(publisherRoot, "current-session.json"), `${JSON.stringify({ sessionId }, null, 2)}\n`, "utf8");

  assert.equal(validatePublicationSession(session).id, sessionId);
  const governedSession = {
    ...session,
    publicationPolicyVersion: 2,
    attempts: { douyin: 1 },
    repostTest: true,
  };
  assert.equal(validatePublicationSession(governedSession).attempts.douyin, 1);
  assert.equal(publicationSessionSummary(governedSession).repostTest, true);
  assert.throws(
    () => validatePublicationSession({ ...governedSession, repostTest: "yes" }),
    /repostTest must be boolean/u,
  );
  assert.throws(
    () => validatePublicationSession({
      ...governedSession,
      attempts: { douyin: MAX_PUBLICATION_ATTEMPTS + 1 },
    }),
    /attempt must be between 1 and 3/u,
  );
  assert.equal(readPublicationSession(root).brief.renderSha256, hash);
  assert.throws(
    () => writePublicationConfirmation(root, sessionId, "douyin", "c".repeat(64)),
    /does not match/,
  );
  const confirmation = writePublicationConfirmation(root, sessionId, "douyin", hash, {
    now: new Date("2026-07-30T03:01:00.000Z"),
  });
  assert.equal(confirmation.command.platform, "douyin");
  assert.equal(confirmation.command.releaseId, releaseId);
  assert.equal(readPublicationConfirmation(root, sessionId, "douyin").renderSha256, hash);

  assert.throws(
    () => updatePublicationPlatform(root, sessionId, "douyin", {
      status: "published_unrecorded",
    }),
    /Invalid douyin publication transition/u,
  );
  updatePublicationPlatform(root, sessionId, "douyin", {
    status: "publishing",
  }, {
    now: new Date("2026-07-30T03:01:30.000Z"),
  });
  const unknown = updatePublicationPlatform(root, sessionId, "douyin", {
    status: "submission_unknown",
  }, {
    now: new Date("2026-07-30T03:01:45.000Z"),
  });
  assert.equal(unknown.platforms.douyin.status, "submission_unknown");
  const updated = updatePublicationPlatform(root, sessionId, "douyin", {
    status: "published_unrecorded",
    proof: {
      url: "https://creator.douyin.com/creator-micro/content/manage",
      signal: "official content management list contains exact title",
    },
  }, {
    now: new Date("2026-07-30T03:02:00.000Z"),
  });
  assert.equal(updated.platforms.douyin.status, "published_unrecorded");
  assert.equal(publicationSessionSummary(updated).queuePosition, 5);
  assert.deepEqual(publicationSessionSummary(governedSession).attempts, { douyin: 1 });

  const manualSessionId = "session-manual";
  const manualSession = {
    ...session,
    id: manualSessionId,
    publicationPolicyVersion: 2,
    attempts: { douyin: 1 },
    repostTest: false,
  };
  fs.writeFileSync(
    path.join(sessionsRoot, `${manualSessionId}.json`),
    `${JSON.stringify(manualSession, null, 2)}\n`,
    "utf8",
  );
  const manualCancelled = updatePublicationPlatform(root, manualSessionId, "douyin", {
    status: "cancelled",
    manualSubmission: {
      reportedAt: "2026-07-30T03:03:00.000Z",
      releaseId,
      renderSha256: hash,
    },
  }, {
    now: new Date("2026-07-30T03:03:00.000Z"),
  });
  assert.equal(manualCancelled.platforms.douyin.status, "cancelled");
  assert.equal(manualCancelled.platforms.douyin.manualSubmission.renderSha256, hash);
  writePublicationConfirmation(root, manualSessionId, "douyin", hash, {
    now: new Date("2026-07-30T03:03:00.000Z"),
    manualSubmission: true,
  });
  assert.equal(readPublicationConfirmation(root, manualSessionId, "douyin").renderSha256, hash);
  const manuallySubmitted = updatePublicationPlatform(root, manualSessionId, "douyin", {
    status: "submission_unknown",
    proof: {
      acceptedSignal: "user reported manual submission from the prepared official form",
      releaseId,
      renderSha256: hash,
    },
  }, {
    now: new Date("2026-07-30T03:03:01.000Z"),
  });
  assert.equal(manuallySubmitted.platforms.douyin.status, "submission_unknown");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("publication workflow: ok");
