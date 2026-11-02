import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildDotPublicationTask, exportDotPublication, exportDotPublicationCalendar,
  selectDotPublicationForDate, validateDotPublicationCalendar, validateDotPublicationCalendarTask,
} from "../lib/dot-publication-manifest.mjs";
import { buildPublicationBrief } from "../lib/publication-workflow.mjs";
import { createReleasePackage } from "../lib/release-package.mjs";
import { upsertCompletedEpisodeIntoPublishQueue } from "../lib/publish-queue.mjs";
import { sha256File } from "../lib/render-manifest.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-dot-manifest-test-"));
const now = new Date("2026-11-02T04:00:00Z");
const config = {
  position: 1,
  mediaUrl: "https://github.com/example/books/releases/download/formal-release/video.mp4",
  accountId: "public_account_123",
  publishDate: "2026-11-02",
  publishTime: "18:30",
  now,
};

function fixture(episodeName) {
  const outputPath = path.join(root, "episodes", episodeName, "renders", "final.mp4");
  const manifestPath = outputPath.replace(/\.mp4$/u, ".manifest.json");
  const publishPath = path.join(root, "episodes", episodeName, "publish.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `test-fixture-media-${episodeName}`);
  fs.writeFileSync(manifestPath, "{}\n");
  const publish = { copy: {
    selectedTitle: "给平凡生活留一点温柔", description: "日常生活里的爱与牵挂。",
    hashtags: ["#读书", "#生活", "#亲情"],
    platforms: { douyin: { title: "抖音专用标题" } },
  } };
  fs.writeFileSync(publishPath, JSON.stringify(publish));
  const completed = {
    episodeName, outputPath, manifestPath, publishPath, publish,
    manifest: {
      episode: { scriptVersion: "v1" },
      output: {
        sha256: sha256File(outputPath), bytes: fs.statSync(outputPath).size, durationSeconds: 45,
        video: { width: 1080, height: 1920, codec: "h264" }, audio: { codec: "aac" },
      },
    },
  };
  const release = createReleasePackage(root, completed, { now });
  upsertCompletedEpisodeIntoPublishQueue(root, { ...completed, release }, { now });
  return release;
}

try {
  const release = fixture("秋天的怀念");
  const secondRelease = fixture("活着");
  const brief = buildPublicationBrief(root, { position: 1 });
  const queuePath = path.join(root, ".agents", "publish-queue.json");
  const ledgerPath = path.join(root, ".agents", "production-ledger.json");
  const beforeQueue = fs.readFileSync(queuePath, "utf8");
  const beforeLedger = fs.readFileSync(ledgerPath, "utf8");

  assert.throws(() => exportDotPublication(root, { position: 1, now }), /publishDate is required/u);
  const missing = exportDotPublication(root, { position: 1, publishDate: config.publishDate, now, output: "missing" });
  assert.equal(missing.task.status, "blocked");
  assert.equal(missing.task.submitAuthorized, false);
  assert.equal(missing.task.media.url, null);
  assert.deepEqual(missing.task.blockedReasons, [
    "missing-media-url",
  ]);
  for (const key of ["mediaUrl", "accountId", "publishTime"]) {
    const partial = { ...config };
    delete partial[key];
    assert.equal(buildDotPublicationTask(brief, partial).submitAuthorized, key !== "mediaUrl");
  }
  const dotManaged = buildDotPublicationTask(brief, { mediaUrl: config.mediaUrl, publishDate: config.publishDate, now });
  assert.equal(dotManaged.submitAuthorized, true);
  assert.equal(dotManaged.account.id, null);
  assert.equal(dotManaged.account.selection, "managed-by-dot");
  assert.equal(dotManaged.account.mustMatchPublicIdBeforeSubmit, false);
  assert.equal(dotManaged.account.requireSameAccountThroughoutExecution, true);
  assert.equal(dotManaged.schedule.managedBy, "dot");
  assert.equal(dotManaged.schedule.notBefore, "2026-11-02T00:00:00+08:00");
  assert.equal(dotManaged.schedule.expiresAt, "2026-11-02T16:00:00.000Z");
  assert.equal(dotManaged.execution.requireScheduleWindowBeforeSubmit, true);

  const ready = exportDotPublication(root, config);
  assert.equal(ready.task.status, "ready");
  assert.equal(ready.task.submitAuthorized, true);
  assert.equal(ready.task.mode, "publish");
  assert.equal(ready.task.testOnly, false);
  assert.equal(ready.task.taskId, missing.task.taskId);
  assert.equal(ready.task.copy.title, "抖音专用标题");
  assert.equal(ready.task.schedule.timeZone, "Asia/Shanghai");
  assert.equal(ready.task.schedule.notBefore, "2026-11-02T18:30:00+08:00");
  assert.equal(ready.task.schedule.expiresAt, "2026-11-02T16:00:00.000Z");
  assert.equal(ready.task.execution.maxPublicationsPerDay, 1);
  assert.equal(ready.task.execution.cover.frameIndex, 0);
  assert.equal(ready.task.execution.requireAllHashtagsSelectedFromOfficialSuggestions, true);
  assert.match(ready.task.execution.onUncertainSubmission, /Never re-upload/u);
  assert.equal(ready.task.evidence.screenshot.fullPage, false);
  assert.equal(ready.task.settings.aiGenerated, true);
  assert.equal(ready.task.settings.allowDownload, false);
  assert.equal(ready.task.settings.cover, "first-frame");
  const readyEntry = ready.current.entries[config.publishDate];
  assert.equal(ready.current.schemaVersion, 2);
  assert.equal(ready.current.kind, "dot-publication-calendar");
  assert.equal(Object.hasOwn(ready.current, "task"), false);
  assert.equal(Object.hasOwn(ready.current, "submitAuthorized"), false);
  assert.equal(readyEntry.taskFile, "daily/2026-11-02.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ready.directory, readyEntry.taskFile), "utf8")), ready.task);
  assert.equal(sha256File(path.join(ready.directory, readyEntry.taskFile)), readyEntry.taskSha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ready.directory, "daily", "current.json"), "utf8")), ready.current);
  assert.deepEqual(exportDotPublication(root, config).current, ready.current);
  assert.deepEqual(exportDotPublication(root, { ...config, now: "2026-11-02T05:00:00Z" }).current, ready.current);
  assert.deepEqual(exportDotPublication(root, { ...config, now: "2026-11-03T05:00:00Z" }).current, ready.current);
  assert.throws(() => exportDotPublication(root, { ...config, publishTime: "19:00" }), /refusing to replace/u);
  assert.throws(() => exportDotPublication(root, { ...config, position: 2 }), /refusing to replace/u);
  assert.throws(() => exportDotPublication(root, { ...config, publishDate: "2026-11-03" }), /Duplicate release/u);
  assert.equal(fs.existsSync(path.join(ready.directory, "daily/2026-11-03.json")), false);
  assert.throws(() => exportDotPublicationCalendar(root, { entries: [config, config], now }), /Duplicate publishDate/u);

  const second = { position: 2, publishDate: "2026-11-03", mediaUrl: config.mediaUrl };
  const calendar = exportDotPublicationCalendar(root, { entries: [second], now });
  assert.deepEqual(calendar.current.entries[config.publishDate], readyEntry);
  assert.deepEqual(Object.keys(calendar.current.entries), ["2026-11-02", "2026-11-03"]);
  const batch = exportDotPublicationCalendar(root, { entries: [config, second], output: "batch", now });
  assert.equal(batch.tasks.length, 2);
  assert.deepEqual(batch.current, calendar.current);
  for (const [instant, date] of [
    ["2026-11-01T15:59:59Z", "2026-11-01"],
    ["2026-11-01T16:00:00Z", "2026-11-02"],
    ["2026-11-02T15:59:59Z", "2026-11-02"],
    ["2026-11-02T16:00:00Z", "2026-11-03"],
    ["2026-11-03T16:00:00Z", "2026-11-04"],
  ]) {
    const selected = selectDotPublicationForDate(calendar.current, instant);
    assert.equal(selected.date, date);
    assert.equal(selected.status, calendar.current.entries[date] ? "selected" : "no_task");
    assert.deepEqual(selectDotPublicationForDate(calendar.current, new Date(instant)), selected);
  }
  assert.equal(selectDotPublicationForDate(calendar.current, "2026-11-03").entry.releaseId, secondRelease.release.releaseId);
  assert.equal(selectDotPublicationForDate(ready.current, "2026-11-03").status, "no_task");
  assert.equal(selectDotPublicationForDate(missing.current, config.publishDate).status, "blocked");
  assert.throws(() => selectDotPublicationForDate(calendar.current, "2026-11-02T12:00:00"), /explicit time zone/u);
  const legacy = { schemaVersion: 1, kind: "dot-publication-daily", task: ready.task };
  assert.throws(() => selectDotPublicationForDate(legacy, now), /explicit migration/u);
  const legacyPath = path.join(root, "legacy", "daily", "current.json");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify(legacy));
  assert.throws(() => exportDotPublication(root, { ...config, output: "legacy" }), /explicit migration/u);
  assert.equal(fs.readFileSync(legacyPath, "utf8"), JSON.stringify(legacy));

  const duplicateTask = structuredClone(calendar.current);
  duplicateTask.entries["2026-11-03"].taskId = ready.task.taskId;
  assert.throws(() => validateDotPublicationCalendar(duplicateTask), /Duplicate taskId/u);
  const badPath = structuredClone(calendar.current);
  badPath.entries["2026-11-03"].taskFile = "../secret.json";
  assert.throws(() => validateDotPublicationCalendar(badPath), /Invalid taskFile/u);
  assert.throws(() => validateDotPublicationCalendar({ ...calendar.current, submitAuthorized: true }), /top-level/u);
  const taskPath = path.join(ready.directory, readyEntry.taskFile);
  const originalTaskText = fs.readFileSync(taskPath, "utf8");
  assert.deepEqual(validateDotPublicationCalendarTask(calendar.current, config.publishDate, originalTaskText), ready.task);
  assert.throws(() => validateDotPublicationCalendarTask(calendar.current, config.publishDate, `${originalTaskText} `), /sha256 mismatch/u);
  for (const mutate of [
    (task) => { task.schedule.date = "2026-11-03"; },
    (task) => { task.releaseId = "f".repeat(64); },
    (task) => { task.media.sha256 = "f".repeat(64); },
    (task) => { task.schedule.notBefore = null; },
  ]) {
    const tampered = structuredClone(ready.task);
    mutate(tampered);
    const text = JSON.stringify(tampered);
    const index = structuredClone(calendar.current);
    index.entries[config.publishDate].taskSha256 = createHash("sha256").update(text).digest("hex");
    assert.throws(() => validateDotPublicationCalendarTask(index, config.publishDate, text), /mismatch|schedule window/u);
  }
  assert.equal(fs.readFileSync(queuePath, "utf8"), beforeQueue);
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), beforeLedger);
  const changedHash = buildDotPublicationTask({ ...brief, renderSha256: "a".repeat(64) }, config);
  assert.notEqual(changedHash.taskId, ready.task.taskId);
  const changedRelease = buildDotPublicationTask({ ...brief, releaseId: "b".repeat(64) }, config);
  assert.notEqual(changedRelease.taskId, ready.task.taskId);

  const noisyBrief = { ...brief, cookie: "DO_NOT_EXPORT", accountSecret: "DO_NOT_EXPORT",
    settings: { ...brief.settings, secretPath: root }, media: { ...brief.media, sourcePath: root } };
  const serialized = JSON.stringify(buildDotPublicationTask(noisyBrief, config));
  for (const forbidden of ["DO_NOT_EXPORT", "videoPath", "releaseManifestPath", "queueStatus",
    "queuePosition", "secretPath", "sourcePath", "episodes/", root, root.replaceAll("\\", "\\\\")]) {
    assert.equal(serialized.includes(forbidden), false, `Export leaked ${forbidden}`);
  }

  for (const publishDate of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-1-02", "invalid"]) {
    assert.throws(() => buildDotPublicationTask(brief, { ...config, publishDate }), /publishDate/u);
  }
  assert.equal(buildDotPublicationTask(brief, { ...config, publishDate: "2028-02-29" }).status, "ready");
  for (const publishTime of ["24:00", "18:60", "8:30"]) {
    assert.throws(() => buildDotPublicationTask(brief, { ...config, publishTime }), /publishTime/u);
  }
  for (const mediaUrl of ["file:///private/video.mp4", "http://example.com/video.mp4", "not-a-url",
    "https://user:secret@example.com/video.mp4", "https://example.com/video.mp4?token=secret",
    "https://example.com/video.mp4#secret", "https://github.com/a/b/releases/download/dot-form-test-2026-11-02/video.mp4"]) {
    assert.throws(() => buildDotPublicationTask(brief, { ...config, mediaUrl }));
  }
  assert.throws(() => buildDotPublicationTask({ ...brief, testOnly: true }, config), /Test-only/u);
  assert.throws(() => buildDotPublicationTask(brief, { ...config, testOnly: false }), /cannot be overridden/u);
  const held = buildDotPublicationTask(brief, { ...config, holdReason: "external-publication-unverified" });
  assert.equal(held.submitAuthorized, false);
  assert.deepEqual(held.blockedReasons, ["external-publication-unverified"]);
  assert.equal(buildDotPublicationTask(brief, { ...config, now: "2026-11-02T16:00:00Z" }).submitAuthorized, false);
  assert.equal(buildDotPublicationTask({ ...brief, queueStatus: { douyin: "published" } }, config).submitAuthorized, false);
  for (const publicationHistory of [
    { everPublished: true }, { latestAttempt: { status: "submission_unknown" } }, { attemptCount: 3 },
  ]) {
    assert.equal(buildDotPublicationTask(brief, { ...config, publicationHistory }).submitAuthorized, false);
  }
  const currentBeforeFailure = fs.readFileSync(path.join(ready.directory, "daily", "current.json"), "utf8");
  const lockPath = path.join(ready.directory, ".calendar-export.lock");
  fs.writeFileSync(lockPath, "");
  assert.throws(() => exportDotPublication(root, config), /EEXIST/u);
  assert.equal(fs.readFileSync(path.join(ready.directory, "daily", "current.json"), "utf8"), currentBeforeFailure);
  fs.unlinkSync(lockPath);
  fs.writeFileSync(taskPath, `${originalTaskText} `);
  assert.throws(() => exportDotPublication(root, config), /manifest sha256 mismatch/u);
  assert.equal(fs.readFileSync(path.join(ready.directory, "daily", "current.json"), "utf8"), currentBeforeFailure);
  fs.writeFileSync(taskPath, originalTaskText);
  const releaseManifest = fs.readFileSync(release.manifestPath, "utf8");
  const changedManifest = JSON.parse(releaseManifest);
  changedManifest.video.sha256 = "f".repeat(64);
  fs.writeFileSync(release.manifestPath, JSON.stringify(changedManifest));
  assert.throws(() => exportDotPublication(root, config), /releaseId does not match release content/u);
  assert.equal(fs.readFileSync(path.join(ready.directory, "daily", "current.json"), "utf8"), currentBeforeFailure);
  fs.writeFileSync(release.manifestPath, releaseManifest);
  const secondMedia = fs.readFileSync(secondRelease.videoPath);
  fs.writeFileSync(secondRelease.videoPath, "tampered-media");
  assert.throws(() => exportDotPublicationCalendar(root, { entries: [config, second], now }), /release video (size|sha256) changed/u);
  assert.equal(fs.readFileSync(path.join(ready.directory, "daily", "current.json"), "utf8"), currentBeforeFailure);
  assert.throws(() => exportDotPublicationCalendar(root, { entries: [config, second], output: "batch-failure", now }), /release video (size|sha256) changed/u);
  assert.equal(fs.existsSync(path.join(root, "batch-failure")), false);
  fs.writeFileSync(secondRelease.videoPath, secondMedia);
  fs.writeFileSync(release.videoPath, "tampered-media");
  assert.throws(() => exportDotPublication(root, config), /release video (size|sha256) changed/u);
  assert.equal(fs.readFileSync(path.join(ready.directory, "daily", "current.json"), "utf8"), currentBeforeFailure);

  const script = fileURLToPath(new URL("../export-dot-publication.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [script, "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--hold-reason/u);
  assert.match(help.stdout, /--plan/u);
  const invalid = spawnSync(process.execPath, [script, "--testOnly", "false"], { cwd: root, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid or duplicate argument/u);
  const mixed = spawnSync(process.execPath, [script, "--plan", "plan.json", "--position", "1"], { cwd: root, encoding: "utf8" });
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /cannot be combined/u);
} finally {
  assert(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}book-video-dot-manifest-test-`));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("dot publication manifest: ok");
