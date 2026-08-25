import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./filesystem.mjs";
import { readJsonFile } from "./json.mjs";
import { readPublishQueue } from "./publish-queue.mjs";
import {
  readProductionLedger,
  recordPlatformPublicationAttempt,
  summarizeProductionRelease,
  updateProductionLedger,
  verifyPublishQueueProjection,
} from "./production-ledger.mjs";
import { readReleasePackage } from "./release-package.mjs";

export const PUBLISH_PLATFORMS = ["douyin", "xiaohongshu"];
export const TERMINAL_PUBLISH_STATUSES = new Set([
  "published",
  "published_unrecorded",
  "submission_unknown",
  "failed",
  "cancelled",
]);
export const MAX_PUBLICATION_ATTEMPTS = 3;
const PUBLICATION_POLICY_VERSION = 2;
const PUBLISH_STATUSES = new Set([
  "not_requested",
  "pending",
  "opening",
  "login_required",
  "preparing",
  "ready",
  "publishing",
  "submission_unknown",
  "published_unrecorded",
  "published",
  "failed",
  "cancelled",
]);
const STATUS_TRANSITIONS = {
  not_requested: [],
  pending: ["opening", "failed"],
  opening: ["login_required", "preparing", "failed"],
  login_required: ["preparing", "failed"],
  preparing: ["ready", "failed"],
  ready: ["publishing", "cancelled", "failed"],
  publishing: ["submission_unknown", "published_unrecorded"],
  submission_unknown: ["published_unrecorded"],
  published_unrecorded: ["published"],
  published: ["submission_unknown"],
  failed: ["published_unrecorded"],
  cancelled: ["submission_unknown"],
};
const UNRESOLVED_ATTEMPT_STATUSES = new Set([
  "opening",
  "login_required",
  "preparing",
  "ready",
  "publishing",
  "submission_unknown",
  "published_unrecorded",
  "published",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function publisherRoot(root) {
  return path.join(root, ".agents", "browser-publisher");
}

function sessionsRoot(root) {
  return path.join(publisherRoot(root), "sessions");
}

function sessionPath(root, sessionId) {
  return path.join(sessionsRoot(root), `${sessionId}.json`);
}

function currentSessionPath(root) {
  return path.join(publisherRoot(root), "current-session.json");
}

function nextPublicationAttempt(root, brief, platform) {
  const directory = sessionsRoot(root);
  if (!fs.existsSync(directory)) return 1;
  const priorAttempts = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJsonFile(path.join(directory, entry.name)))
    .filter((session) => (
      session?.publicationPolicyVersion === PUBLICATION_POLICY_VERSION
      && session?.brief?.releaseId === brief.releaseId
      && session?.requestedPlatforms?.includes(platform)
      && Number.isInteger(session?.attempts?.[platform])
    ));
  return priorAttempts.length + 1;
}

function syncPublicationAttemptToLedger(root, session, platform) {
  const state = session.platforms[platform];
  return updateProductionLedger(root, (ledger) => {
    recordPlatformPublicationAttempt(ledger, {
      releaseId: session.brief.releaseId,
      platform,
      source: "live-publication-session",
      sessionId: session.id,
      attemptNumber: session.attempts?.[platform],
      status: state.status,
      startedAt: session.createdAt,
      updatedAt: state.updatedAt,
      queuePosition: session.brief.queuePosition,
      account: session.accounts?.[platform],
      confirmation: state.confirmation,
      sessionEvidence: state.proof,
      sourcePath: path.relative(root, sessionPath(root, session.id)).split(path.sep).join("/"),
    });
    return ledger;
  }, { now: state.updatedAt });
}

export function commandPath(root, sessionId, platform) {
  assert(PUBLISH_PLATFORMS.includes(platform), `Unsupported publication platform: ${platform}`);
  return path.join(publisherRoot(root), "commands", `${sessionId}.${platform}.confirm.json`);
}

export function buildPublicationBrief(root, options = {}) {
  const queue = readPublishQueue(root, { required: true });
  const position = options.position === undefined ? null : Number(options.position);
  const book = String(options.book || "").trim();
  const matches = queue.items.filter((item) => (
    (position !== null && item.position === position)
    || (book && item.book === book)
  ));
  assert(matches.length === 1, `Expected exactly one publication queue item, found ${matches.length}`);
  const queueItem = matches[0];
  const ledger = readProductionLedger(root, { required: true });
  verifyPublishQueueProjection(ledger, [queueItem]);
  assert(
    queueItem.releaseId && queueItem.releaseManifestPath,
    `Queue item ${queueItem.book} has no immutable release; run stock:finalize again`,
  );
  const releaseResult = readReleasePackage(root, queueItem.releaseManifestPath);
  const release = releaseResult.release;
  assert(release.releaseId === queueItem.releaseId, `Release id mismatch for ${queueItem.book}`);
  assert(release.video.sha256 === String(queueItem.renderSha256).toLowerCase(), `Release hash mismatch for ${queueItem.book}`);
  assert(release.episode.name === queueItem.book, `Release book mismatch for ${queueItem.book}`);
  assert(release.episode.scriptVersion === queueItem.scriptVersion, `Release scriptVersion mismatch for ${queueItem.book}`);
  assert(release.publication.common.title === queueItem.title, `Release title mismatch for ${queueItem.book}`);
  assert(release.publication.common.description === queueItem.description, `Release description mismatch for ${queueItem.book}`);
  const tags = release.publication.common.hashtags.map((tag) => String(tag).trim()).filter(Boolean);
  assert(tags.length >= 3 && tags.length <= 5, `Expected 3-5 publication hashtags for ${queueItem.book}`);

  return {
    schemaVersion: 1,
    releaseId: release.releaseId,
    releaseManifestPath: queueItem.releaseManifestPath,
    queuePosition: queueItem.position,
    book: queueItem.book,
    videoPath: releaseResult.videoPath,
    activeVideoPath: path.resolve(queueItem.videoPath),
    renderSha256: release.video.sha256,
    media: {
      bytes: release.video.bytes,
      durationSeconds: release.video.durationSeconds,
      videoCodec: release.video.videoCodec,
      audioCodec: release.video.audioCodec,
      width: release.video.width,
      height: release.video.height,
    },
    copy: {
      title: queueItem.title,
      description: queueItem.description,
      hashtags: tags,
    },
    platformCopy: structuredClone(release.publication.platforms),
    settings: {
      ...release.policy,
      location: "",
    },
    queueStatus: {
      douyin: queueItem.douyinStatus,
      xiaohongshu: queueItem.xiaohongshuStatus,
    },
  };
}

export function validatePublicationSession(session, filePath = "publication-session.json") {
  assert(session && typeof session === "object" && !Array.isArray(session), `${filePath}: session must be an object`);
  assert(session.schemaVersion === 1, `${filePath}: unsupported schemaVersion`);
  assert(typeof session.id === "string" && session.id.trim(), `${filePath}: id must be non-empty`);
  assert(typeof session.createdAt === "string" && Number.isFinite(Date.parse(session.createdAt)), `${filePath}: createdAt must be an ISO date`);
  assert(typeof session.updatedAt === "string" && Number.isFinite(Date.parse(session.updatedAt)), `${filePath}: updatedAt must be an ISO date`);
  assert(session.brief && typeof session.brief === "object", `${filePath}: brief must be an object`);
  assert(/^[a-f0-9]{64}$/u.test(session.brief.releaseId), `${filePath}: brief releaseId is invalid`);
  assert(/^[a-f0-9]{64}$/u.test(session.brief.renderSha256), `${filePath}: brief renderSha256 is invalid`);
  if (session.publicationPolicyVersion !== undefined) {
    assert(
      session.publicationPolicyVersion === PUBLICATION_POLICY_VERSION,
      `${filePath}: unsupported publicationPolicyVersion`,
    );
    assert(session.attempts && typeof session.attempts === "object", `${filePath}: attempts must be an object`);
    for (const platform of session.requestedPlatforms) {
      assert(
        Number.isInteger(session.attempts[platform])
        && session.attempts[platform] >= 1
        && session.attempts[platform] <= MAX_PUBLICATION_ATTEMPTS,
        `${filePath}: ${platform} attempt must be between 1 and ${MAX_PUBLICATION_ATTEMPTS}`,
      );
    }
  }
  if (session.repostTest !== undefined) {
    assert(typeof session.repostTest === "boolean", `${filePath}: repostTest must be boolean`);
  }
  assert(session.platforms && typeof session.platforms === "object", `${filePath}: platforms must be an object`);
  for (const platform of PUBLISH_PLATFORMS) {
    const state = session.platforms[platform];
    assert(state && typeof state === "object", `${filePath}: missing ${platform} state`);
    assert(PUBLISH_STATUSES.has(state.status), `${filePath}: unsupported ${platform}.status ${state.status}`);
    assert(typeof state.updatedAt === "string" && Number.isFinite(Date.parse(state.updatedAt)), `${filePath}: ${platform}.updatedAt must be an ISO date`);
  }
  return session;
}

export function createPublicationSession(root, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const nowText = now.toISOString();
  const platforms = options.platforms?.length ? options.platforms : PUBLISH_PLATFORMS;
  assert(platforms.every((platform) => PUBLISH_PLATFORMS.includes(platform)), "Unsupported publication platform requested");
  const brief = buildPublicationBrief(root, options);
  const repostTest = options.repostTest === true;
  const ledger = readProductionLedger(root, { required: true });
  const releaseHistory = summarizeProductionRelease(ledger, brief.releaseId);
  for (const platform of platforms) {
    const expectedStatus = repostTest ? "published" : "pending";
    assert(
      brief.queueStatus[platform] === expectedStatus,
      `${platform} must be ${expectedStatus} for queue item ${brief.queuePosition}`,
    );
    if (!repostTest) {
      const latestAttempt = releaseHistory.platforms[platform].latestAttempt;
      assert(
        !latestAttempt || !UNRESOLVED_ATTEMPT_STATUSES.has(latestAttempt.status),
        `${platform} release ${brief.releaseId} has unresolved session ${latestAttempt?.sessionId || latestAttempt?.id}: ${latestAttempt?.status}`,
      );
    }
  }
  const attempts = Object.fromEntries(platforms.map((platform) => {
    const attempt = nextPublicationAttempt(root, brief, platform);
    assert(
      attempt <= MAX_PUBLICATION_ATTEMPTS,
      `${platform} reached the ${MAX_PUBLICATION_ATTEMPTS}-attempt limit for release ${brief.releaseId}`,
    );
    return [platform, attempt];
  }));
  const session = {
    schemaVersion: 1,
    publicationPolicyVersion: PUBLICATION_POLICY_VERSION,
    id: options.sessionId || crypto.randomUUID(),
    createdAt: nowText,
    updatedAt: nowText,
    requestedPlatforms: [...platforms],
    attempts,
    repostTest,
    accounts: options.accounts || {},
    brief,
    platforms: Object.fromEntries(PUBLISH_PLATFORMS.map((platform) => [
      platform,
      {
        status: platforms.includes(platform) ? "pending" : "not_requested",
        updatedAt: nowText,
      },
    ])),
  };
  validatePublicationSession(session);
  fs.mkdirSync(sessionsRoot(root), { recursive: true });
  writeFileAtomically(sessionPath(root, session.id), `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8" });
  writeFileAtomically(currentSessionPath(root), `${JSON.stringify({ sessionId: session.id }, null, 2)}\n`, { encoding: "utf8" });
  for (const platform of platforms) syncPublicationAttemptToLedger(root, session, platform);
  return session;
}

export function readPublicationSession(root, sessionId = "") {
  let resolvedId = String(sessionId || "").trim();
  if (!resolvedId) {
    const pointerPath = currentSessionPath(root);
    assert(fs.existsSync(pointerPath), `Missing current publication session: ${pointerPath}`);
    resolvedId = String(readJsonFile(pointerPath).sessionId || "").trim();
  }
  assert(resolvedId, "Publication session id is required");
  const filePath = sessionPath(root, resolvedId);
  assert(fs.existsSync(filePath), `Missing publication session: ${filePath}`);
  return validatePublicationSession(readJsonFile(filePath), filePath);
}

export function updatePublicationSession(root, sessionId, updater, options = {}) {
  const current = readPublicationSession(root, sessionId);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const next = updater(structuredClone(current));
  next.updatedAt = now.toISOString();
  validatePublicationSession(next);
  writeFileAtomically(sessionPath(root, sessionId), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
  return next;
}

export function updatePublicationPlatform(root, sessionId, platform, patch, options = {}) {
  assert(PUBLISH_PLATFORMS.includes(platform), `Unsupported publication platform: ${platform}`);
  const updated = updatePublicationSession(root, sessionId, (session) => {
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const currentStatus = session.platforms[platform].status;
    const nextStatus = patch.status || currentStatus;
    assert(PUBLISH_STATUSES.has(nextStatus), `Unsupported ${platform} publication status: ${nextStatus}`);
    assert(
      nextStatus === currentStatus || STATUS_TRANSITIONS[currentStatus].includes(nextStatus),
      `Invalid ${platform} publication transition: ${currentStatus} -> ${nextStatus}`,
    );
    if (currentStatus === "published" && nextStatus === "submission_unknown") {
      assert(session.repostTest === true, "Only test repost sessions can revalidate published proof");
    }
    if (currentStatus === "cancelled" && nextStatus === "submission_unknown") {
      assert(
        session.platforms[platform].manualSubmission?.renderSha256 === session.brief.renderSha256,
        `Manual ${platform} submission acknowledgement does not match the prepared render`,
      );
    }
    session.platforms[platform] = {
      ...session.platforms[platform],
      ...patch,
      updatedAt: now.toISOString(),
    };
    return session;
  }, options);
  syncPublicationAttemptToLedger(root, updated, platform);
  return updated;
}

export function writePublicationConfirmation(root, sessionId, platform, expectedRenderSha256, options = {}) {
  const session = readPublicationSession(root, sessionId);
  assert(session.requestedPlatforms.includes(platform), `${platform} was not requested in session ${session.id}`);
  const manualSubmission = options.manualSubmission === true;
  assert(
    session.platforms[platform].status === (manualSubmission ? "cancelled" : "ready"),
    `${platform} is not ready for final publication`,
  );
  const normalizedSha = String(expectedRenderSha256 || "").trim().toLowerCase();
  assert(normalizedSha === session.brief.renderSha256, "Final confirmation SHA does not match the prepared render");
  if (manualSubmission) {
    assert(platform === "douyin", "Manual submission acknowledgement is supported only for douyin");
    assert(session.repostTest !== true, "Test repost sessions cannot acknowledge a manual submission");
    assert(
      session.platforms[platform].manualSubmission?.renderSha256 === normalizedSha,
      "Manual submission acknowledgement does not match the prepared render",
    );
  }
  const command = {
    schemaVersion: 1,
    sessionId: session.id,
    platform,
    releaseId: session.brief.releaseId,
    renderSha256: normalizedSha,
    confirmedAt: options.now instanceof Date
      ? options.now.toISOString()
      : String(options.now || new Date().toISOString()),
  };
  const filePath = commandPath(root, session.id, platform);
  writeFileAtomically(filePath, `${JSON.stringify(command, null, 2)}\n`, { encoding: "utf8" });
  return { command, filePath };
}

export function readPublicationConfirmation(root, sessionId, platform) {
  const filePath = commandPath(root, sessionId, platform);
  if (!fs.existsSync(filePath)) return null;
  const command = readJsonFile(filePath);
  assert(command?.schemaVersion === 1, `${filePath}: unsupported schemaVersion`);
  assert(command.sessionId === sessionId, `${filePath}: sessionId mismatch`);
  assert(command.platform === platform, `${filePath}: platform mismatch`);
  assert(/^[a-f0-9]{64}$/u.test(String(command.releaseId)), `${filePath}: releaseId is invalid`);
  assert(/^[a-f0-9]{64}$/u.test(String(command.renderSha256)), `${filePath}: renderSha256 is invalid`);
  assert(Number.isFinite(Date.parse(command.confirmedAt)), `${filePath}: confirmedAt must be an ISO date`);
  return command;
}

export function publicationSessionSummary(session) {
  return {
    sessionId: session.id,
    queuePosition: session.brief.queuePosition,
    book: session.brief.book,
    releaseId: session.brief.releaseId,
    renderSha256: session.brief.renderSha256,
    videoPath: session.brief.videoPath,
    attempts: session.attempts || {},
    repostTest: session.repostTest === true,
    platforms: Object.fromEntries(PUBLISH_PLATFORMS.map((platform) => [
      platform,
      session.platforms[platform],
    ])),
  };
}
