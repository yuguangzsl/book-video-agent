import path from "node:path";
import { createHash } from "node:crypto";
import { buildPublicationBrief } from "./publication-workflow.mjs";
import { readProductionLedger, summarizeProductionRelease } from "./production-ledger.mjs";
import { writeFileAtomically } from "./filesystem.mjs";

const TIME_ZONE = "Asia/Shanghai";
const UNRESOLVED_ATTEMPTS = new Set([
  "opening", "login_required", "preparing", "ready", "publishing",
  "submission_unknown", "published_unrecorded", "published",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  assert(typeof value === "string" && value.trim(), `${field} must be non-empty text`);
  return value.trim();
}

function mediaUrl(value) {
  const text = optionalText(value, "mediaUrl");
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { throw new Error("mediaUrl must be an absolute HTTPS URL"); }
  assert(url.protocol === "https:" && url.hostname, "mediaUrl must use HTTPS");
  assert(!url.username && !url.password && !url.search && !url.hash,
    "mediaUrl must not contain credentials, query parameters, or fragments");
  assert(!/dot-form-test/iu.test(decodeURIComponent(url.pathname)),
    "Test release URLs cannot authorize formal publication; use a formal media asset");
  return url.href;
}

function publicationDate(value) {
  const text = optionalText(value, "publishDate");
  if (!text) return null;
  assert(/^\d{4}-\d{2}-\d{2}$/u.test(text), "publishDate must be YYYY-MM-DD");
  const date = new Date(`${text}T00:00:00.000Z`);
  assert(Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === text,
    "publishDate must be a valid calendar date");
  return text;
}

export function buildDotPublicationTask(brief, options = {}) {
  assert(brief && brief.testOnly !== true && brief.mode !== "test",
    "Test-only packages cannot authorize formal publication");
  assert(options.testOnly === undefined && options.mode === undefined,
    "Publication mode and testOnly cannot be overridden");
  assert(/^[a-f0-9]{64}$/u.test(brief.releaseId), "Invalid releaseId");
  assert(/^[a-f0-9]{64}$/u.test(brief.renderSha256), "Invalid renderSha256");
  const copy = brief.platformCopy?.douyin;
  assert(copy && typeof copy.title === "string" && copy.title.trim()
    && typeof copy.description === "string" && copy.description.trim()
    && Array.isArray(copy.hashtags) && copy.hashtags.length >= 3 && copy.hashtags.length <= 5
    && copy.hashtags.every((tag) => typeof tag === "string" && tag.trim()),
  "Validated Douyin publication copy is required");
  const url = mediaUrl(options.mediaUrl);
  const accountId = optionalText(options.accountId, "accountId");
  assert(!accountId || /^[\p{L}\p{N}_.-]{1,100}$/u.test(accountId),
    "accountId must be the public Douyin identifier, not credentials");
  const date = publicationDate(options.publishDate);
  const time = optionalText(options.publishTime, "publishTime");
  assert(!time || /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time), "publishTime must be HH:mm");
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  assert(Number.isFinite(now.valueOf()), "Invalid current time");
  const holdReason = optionalText(options.holdReason, "holdReason");
  const blockedReasons = [];
  if (!url) blockedReasons.push("missing-media-url");
  if (holdReason) blockedReasons.push(holdReason);
  if (brief.queueStatus?.douyin !== "pending") blockedReasons.push("release-not-pending");
  if (options.publicationHistory?.everPublished) blockedReasons.push("release-already-published");
  if (UNRESOLVED_ATTEMPTS.has(options.publicationHistory?.latestAttempt?.status)) {
    blockedReasons.push("unresolved-publication-attempt");
  }
  if (options.publicationHistory?.attemptCount >= 3) blockedReasons.push("publication-attempt-limit");
  const notBefore = date && time ? `${date}T${time}:00+08:00` : null;
  const expiresAt = date
    ? new Date(Date.parse(`${date}T00:00:00+08:00`) + 86400000).toISOString()
    : null;
  if (expiresAt && now.valueOf() >= Date.parse(expiresAt)) blockedReasons.push("publication-date-expired");
  const taskId = createHash("sha256").update(JSON.stringify({
    platform: "douyin", releaseId: brief.releaseId, renderSha256: brief.renderSha256,
  })).digest("hex");
  const settings = {};
  for (const key of ["cover", "visibility", "timing", "allowDownload", "aiGenerated",
    "commercialPromotion", "originalDeclaration", "monetization", "location"]) {
    assert(Object.hasOwn(brief.settings || {}, key), `Missing publication setting: ${key}`);
    settings[key] = brief.settings[key];
  }
  const ready = blockedReasons.length === 0;
  return {
    schemaVersion: 1,
    kind: "dot-publication-task",
    taskId,
    platform: "douyin",
    mode: "publish",
    testOnly: false,
    status: ready ? "ready" : "blocked",
    submitAuthorized: ready,
    blockedReasons,
    generatedAt: now.toISOString(),
    releaseId: brief.releaseId,
    renderSha256: brief.renderSha256,
    account: { id: accountId, selection: accountId ? "specified-public-id" : "managed-by-dot",
      mustMatchPublicIdBeforeSubmit: Boolean(accountId), requireSameAccountThroughoutExecution: true },
    schedule: { timeZone: TIME_ZONE, managedBy: "dot", date, time, notBefore, expiresAt },
    media: {
      url,
      sha256: brief.renderSha256,
      bytes: brief.media.bytes,
      width: brief.media.width,
      height: brief.media.height,
      durationSeconds: brief.media.durationSeconds,
      verifyDownloadedHashBeforeUpload: true,
    },
    copy: { title: copy.title, description: copy.description, hashtags: [...copy.hashtags] },
    settings,
    execution: {
      method: "dot-computer-use",
      officialUploadUrl: "https://creator.douyin.com/creator-micro/content/upload",
      officialWorkListUrl: "https://creator.douyin.com/creator-micro/content/manage",
      maxPublicationsPerDay: 1,
      dailyLimitScope: "account-and-Asia/Shanghai-calendar-date",
      requireCurrentManifestMatchBeforeSubmit: true,
      requireScheduleWindowBeforeSubmit: Boolean(date),
      requireOfficialListAndPersistentReceiptCheckBeforeUpload: true,
      blockIfDailyPublicationOrPriorTaskOutcomeUnknown: true,
      requireAllHashtagsSelectedFromOfficialSuggestions: true,
      blockPlainOrMismatchedHashtags: true,
      requireExactCopyAndSettingsReview: true,
      cover: { source: "video-frame", frameIndex: 0, requireVisibleBitmapTitleAndAuthor: true },
      finalPublishClicks: 1,
      onUncertainSubmission: "Stop. Inspect the official work list and save evidence. Never re-upload or click publish again while the outcome is uncertain.",
      onExistingExactTitle: "Do not publish again. Collect official-list evidence and report the existing work for reconciliation.",
      retryRequiresAuthoritativeAbsenceAndNewAuthorization: true,
      testPackagesAreNeverAuthorization: true,
    },
    evidence: {
      requiredForPublished: ["taskId", "releaseId", "renderSha256", "accountId", "exactTitle",
        "officialWorkListUrl", "workIdOrUrl", "submittedState", "verifiedAt", "viewportScreenshot"],
      acceptedSubmittedStates: ["published", "under_review"],
      screenshot: { fullPage: false, matchedWorkMustBeVisible: true },
      mustReturnEvidenceToUser: true,
      chatClaimOrUploadCompletionIsNotProof: true,
      missingEvidenceOutcome: "unverified",
    },
  };
}

export function exportDotPublication(root, options = {}) {
  assert(Number.isInteger(Number(options.position)) && Number(options.position) > 0,
    "position must be a positive integer");
  const brief = buildPublicationBrief(root, { position: Number(options.position) });
  const history = summarizeProductionRelease(readProductionLedger(root, { required: true }), brief.releaseId);
  const task = buildDotPublicationTask(brief, { ...options, publicationHistory: history.platforms.douyin });
  const directory = path.resolve(root, options.output || ".agents/dot-publication-export");
  const taskText = `${JSON.stringify(task, null, 2)}\n`;
  const taskSha256 = createHash("sha256").update(taskText).digest("hex");
  const taskFile = `tasks/${task.taskId}/${taskSha256}.json`;
  const current = {
    schemaVersion: 1,
    kind: "dot-publication-daily",
    mode: "publish",
    testOnly: false,
    status: task.status,
    submitAuthorized: task.submitAuthorized,
    timeZone: TIME_ZONE,
    date: task.schedule.date,
    maxPublicationsPerDay: 1,
    taskFile,
    taskSha256,
    task,
  };
  writeFileAtomically(path.join(directory, taskFile), taskText, { encoding: "utf8" });
  writeFileAtomically(path.join(directory, "daily", "current.json"), `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8" });
  return { task, current, directory };
}
