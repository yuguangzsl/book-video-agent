import fs from "node:fs";
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
  assert(text, "publishDate is required");
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
  const notBefore = `${date}T${time || "00:00"}:00+08:00`;
  const expiresAt = new Date(Date.parse(`${date}T00:00:00+08:00`) + 86400000).toISOString();
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

const CALENDAR_SELECTION = Object.freeze({
  timeZone: TIME_ZONE, strategy: "strict-today-only", onNoTask: "stop",
  allowEarly: false, allowCatchUp: false,
});
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function calendarEntry(task, taskText) {
  return {
    taskFile: `daily/${task.schedule.date}.json`, taskSha256: sha256(taskText),
    taskId: task.taskId, releaseId: task.releaseId, renderSha256: task.renderSha256,
    status: task.status, submitAuthorized: task.submitAuthorized,
  };
}

export function validateDotPublicationCalendar(current) {
  assert(isObject(current) && current.schemaVersion === 2 && current.kind === "dot-publication-calendar",
    "Unsupported calendar schema; legacy current.json requires explicit migration to schemaVersion 2 in a new output directory");
  assert(!Object.hasOwn(current, "task") && !Object.hasOwn(current, "taskFile")
    && !Object.hasOwn(current, "submitAuthorized"), "Calendar must not authorize a top-level task");
  assert(current.mode === "publish" && current.testOnly === false
    && current.maxPublicationsPerDay === 1, "Invalid calendar publication policy");
  assert(isObject(current.selection) && Object.entries(CALENDAR_SELECTION)
    .every(([key, value]) => current.selection[key] === value), "Calendar must select strictly today in Asia/Shanghai");
  assert(isObject(current.entries), "Calendar entries must be a date-keyed object");
  const tasks = new Set();
  const releases = new Set();
  for (const [date, entry] of Object.entries(current.entries)) {
    publicationDate(date);
    assert(isObject(entry) && entry.taskFile === `daily/${date}.json`, `Invalid taskFile for ${date}`);
    for (const field of ["taskSha256", "taskId", "releaseId", "renderSha256"]) {
      assert(typeof entry[field] === "string" && /^[a-f0-9]{64}$/u.test(entry[field]), `Invalid ${field} for ${date}`);
    }
    const identity = `${entry.releaseId}:${entry.renderSha256}`;
    assert(!releases.has(identity), `Duplicate release and render across calendar dates: ${date}`);
    assert(!tasks.has(entry.taskId), `Duplicate taskId across calendar dates: ${date}`);
    assert(entry.taskId === sha256(JSON.stringify({ platform: "douyin",
      releaseId: entry.releaseId, renderSha256: entry.renderSha256 })), `Task identity mismatch for ${date}`);
    assert(["ready", "blocked"].includes(entry.status)
      && entry.submitAuthorized === (entry.status === "ready"), `Invalid authorization for ${date}`);
    tasks.add(entry.taskId);
    releases.add(identity);
  }
  return current;
}

// taskText must be the exact downloaded bytes, before parsing or reformatting.
export function validateDotPublicationCalendarTask(current, date, taskText) {
  validateDotPublicationCalendar(current);
  publicationDate(date);
  const entry = current.entries[date];
  assert(entry, `No calendar task for ${date}`);
  assert(typeof taskText === "string" && sha256(taskText) === entry.taskSha256, `Task manifest sha256 mismatch for ${date}`);
  const task = JSON.parse(taskText);
  assert(task?.schemaVersion === 1 && task.kind === "dot-publication-task"
    && task.platform === "douyin" && task.mode === "publish" && task.testOnly === false,
  `Invalid publication task for ${date}`);
  for (const field of ["taskId", "releaseId", "renderSha256", "status", "submitAuthorized"]) {
    assert(task[field] === entry[field], `Task/index ${field} mismatch for ${date}`);
  }
  assert(task.schedule?.date === date && task.schedule.timeZone === TIME_ZONE,
    `Task/index date mismatch for ${date}`);
  const time = task.schedule.time;
  assert(time === null || (typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)), "Invalid task time");
  assert(task.schedule.notBefore === `${date}T${time || "00:00"}:00+08:00`
    && task.schedule.expiresAt === new Date(Date.parse(`${date}T00:00:00+08:00`) + 86400000).toISOString(),
  `Invalid task schedule window for ${date}`);
  assert(task.media?.sha256 === task.renderSha256 && task.media.verifyDownloadedHashBeforeUpload === true,
    `Task media identity mismatch for ${date}`);
  assert(Array.isArray(task.blockedReasons) && (task.status === "ready"
    ? task.blockedReasons.length === 0 && mediaUrl(task.media.url)
    : task.blockedReasons.length > 0), `Invalid task authorization for ${date}`);
  return task;
}

export function selectDotPublicationForDate(current, dateOrNow = new Date()) {
  validateDotPublicationCalendar(current);
  let date;
  if (typeof dateOrNow === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(dateOrNow)) {
    date = publicationDate(dateOrNow);
  } else {
    assert(dateOrNow instanceof Date || typeof dateOrNow === "number"
      || (typeof dateOrNow === "string" && /(?:Z|[+-]\d{2}:\d{2})$/u.test(dateOrNow)),
    "Current time must include an explicit time zone");
    const now = dateOrNow instanceof Date ? dateOrNow : new Date(dateOrNow);
    assert(Number.isFinite(now.valueOf()), "Invalid current time");
    date = new Date(now.valueOf() + 8 * 3600000).toISOString().slice(0, 10);
  }
  const entry = current.entries[date];
  if (!entry) return { status: "no_task", date, reason: "no-task-for-today" };
  if (!entry.submitAuthorized) return { status: "blocked", date, entry: { ...entry } };
  return { status: "selected", date, entry: { ...entry } };
}

export function exportDotPublicationCalendar(root, options = {}) {
  assert(Array.isArray(options.entries) && options.entries.length > 0, "entries must be a non-empty array");
  const directory = path.resolve(root, options.output || ".agents/dot-publication-export");
  const currentPath = path.join(directory, "daily", "current.json");
  const currentBefore = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, "utf8") : null;
  const current = currentBefore !== null
    ? validateDotPublicationCalendar(JSON.parse(currentBefore))
    : { schemaVersion: 2, kind: "dot-publication-calendar", mode: "publish", testOnly: false,
      maxPublicationsPerDay: 1, selection: { ...CALENDAR_SELECTION }, entries: {} };
  const existingTasks = new Map();
  for (const [date, entry] of Object.entries(current.entries)) {
    const text = fs.readFileSync(path.join(directory, entry.taskFile), "utf8");
    existingTasks.set(date, { task: validateDotPublicationCalendarTask(current, date, text), text });
  }
  const ledger = readProductionLedger(root, { required: true });
  const dates = new Set();
  const prepared = options.entries.map((entry) => {
    assert(isObject(entry), "Each plan entry must be an object");
    const date = publicationDate(entry.publishDate);
    assert(!dates.has(date), `Duplicate publishDate in plan: ${date}`);
    dates.add(date);
    assert(Number.isInteger(Number(entry.position)) && Number(entry.position) > 0,
      "position must be a positive integer");
    const brief = buildPublicationBrief(root, { position: Number(entry.position) });
    const history = summarizeProductionRelease(ledger, brief.releaseId);
    const taskFile = `daily/${date}.json`;
    const targetPath = path.join(directory, taskFile);
    let existing = existingTasks.get(date);
    if (!existing && fs.existsSync(targetPath)) {
      const text = fs.readFileSync(targetPath, "utf8");
      existing = { task: JSON.parse(text), text };
    }
    // Preserve the original creation-time decision; date selection still excludes all expired days.
    let task = buildDotPublicationTask(brief, { ...entry, now: existing ? existing.task.generatedAt : options.now,
      publicationHistory: history.platforms.douyin });
    let taskText = jsonText(task);
    if (existing) {
      assert(taskText === jsonText(existing.task),
        `Daily task already exists for ${date}; refusing to replace or reschedule it`);
      task = existing.task;
      taskText = existing.text;
    }
    return { task, taskText, taskFile, targetPath, exists: Boolean(existing) };
  });
  for (const item of prepared) current.entries[item.task.schedule.date] = calendarEntry(item.task, item.taskText);
  current.entries = Object.fromEntries(Object.entries(current.entries).sort(([a], [b]) => a.localeCompare(b)));
  validateDotPublicationCalendar(current);
  for (const item of prepared) validateDotPublicationCalendarTask(current, item.task.schedule.date, item.taskText);
  // No output is written until every source, daily task, and the merged calendar has passed validation.
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, ".calendar-export.lock");
  const lock = fs.openSync(lockPath, "wx");
  try {
    assert((fs.existsSync(currentPath) ? fs.readFileSync(currentPath, "utf8") : null) === currentBefore,
      "Calendar changed during export; rerun against the current index");
    for (const [date, existing] of existingTasks) {
      assert(fs.readFileSync(path.join(directory, `daily/${date}.json`), "utf8") === existing.text,
        `Daily task changed during export: ${date}`);
    }
    for (const item of prepared) {
      assert(item.exists ? fs.readFileSync(item.targetPath, "utf8") === item.taskText : !fs.existsSync(item.targetPath),
        `Daily task changed during export: ${item.task.schedule.date}`);
    }
    for (const item of prepared) {
      if (!item.exists) writeFileAtomically(item.targetPath, item.taskText, { encoding: "utf8" });
    }
    writeFileAtomically(currentPath, jsonText(current), { encoding: "utf8" });
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
  return { tasks: prepared.map(({ task }) => task), current, directory, currentFile: "daily/current.json" };
}

export function exportDotPublication(root, options = {}) {
  const result = exportDotPublicationCalendar(root, { entries: [options], output: options.output, now: options.now });
  return { ...result, task: result.tasks[0] };
}
