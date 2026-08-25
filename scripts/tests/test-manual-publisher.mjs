import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildXiaohongshuManualPayload,
  XIAOHONGSHU_PUBLISH_URL,
} from "../lib/manual-publisher.mjs";
import {
  assertManualXiaohongshuVerificationBrief,
  manualXiaohongshuVerificationFailureStatus,
  manualXiaohongshuVerificationStatusPath,
  manualPanelProcessIsRunning,
  validateManualXiaohongshuVerificationPayload,
  waitForManualPanelClose,
} from "../lib/manual-xiaohongshu-verification.mjs";
import {
  assertBrowserAutomationPlatforms,
  assertReadOnlyVerificationPlatforms,
  BROWSER_AUTOMATION_PLATFORMS,
  effectivePublicationStatus,
  publicationStatusBlocksCompletion,
  PUBLICATION_COMPLETION_REQUIRED_PLATFORMS,
  READ_ONLY_VERIFICATION_PLATFORMS,
  XIAOHONGSHU_POST_CLOSE_VERIFICATION_ENABLED,
  XIAOHONGSHU_STATUS_SOURCE,
} from "../lib/publication-policy.mjs";

assert.deepEqual(BROWSER_AUTOMATION_PLATFORMS, ["douyin"]);
assert.equal(XIAOHONGSHU_POST_CLOSE_VERIFICATION_ENABLED, false);
assert.equal(XIAOHONGSHU_STATUS_SOURCE, "douyin");
assert.deepEqual(READ_ONLY_VERIFICATION_PLATFORMS, ["douyin"]);
assert.deepEqual(PUBLICATION_COMPLETION_REQUIRED_PLATFORMS, ["douyin"]);
assert.deepEqual(assertBrowserAutomationPlatforms(["douyin"]), ["douyin"]);
assert.deepEqual(assertReadOnlyVerificationPlatforms(["douyin"]), ["douyin"]);
assert.throws(
  () => assertReadOnlyVerificationPlatforms(["xiaohongshu"]),
  /Read-only publication verification is disabled for xiaohongshu/u,
);
assert.equal(publicationStatusBlocksCompletion("douyin", "pending"), true);
assert.equal(publicationStatusBlocksCompletion("xiaohongshu", "pending"), false);
assert.equal(
  effectivePublicationStatus("xiaohongshu", { douyin: "published", xiaohongshu: "pending" }),
  "published",
);
assert.throws(
  () => assertBrowserAutomationPlatforms(["xiaohongshu"]),
  /Browser automation is disabled for xiaohongshu/u,
);
assert.throws(
  () => assertBrowserAutomationPlatforms(["douyin", "xiaohongshu"]),
  /publish:xiaohongshu/u,
);

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-manual-publisher-test-"));
const videoPath = path.join(testRoot, "release-video.mp4");
const payloadPath = path.join(testRoot, "payload.json");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const panelScript = path.resolve(scriptDir, "..", "publish-xiaohongshu-panel.ps1");
const launcherScript = path.resolve(scriptDir, "..", "publish-xiaohongshu-manual.mjs");
const verifierScript = path.resolve(scriptDir, "..", "verify-xiaohongshu-manual.mjs");

try {
  fs.writeFileSync(videoPath, "test-video", "utf8");
  const payload = buildXiaohongshuManualPayload({
    queuePosition: 3,
    book: "测试图书",
    releaseId: "a".repeat(64),
    renderSha256: "b".repeat(64),
    videoPath,
    platformCopy: {
      xiaohongshu: {
        title: "小红书标题",
        description: "小红书简介",
        hashtags: ["读书", "#成长", "生活"],
      },
    },
    settings: {
      aiGenerated: true,
      originalDeclaration: false,
      allowDownload: false,
      commercialPromotion: false,
      visibility: "public",
      timing: "immediate",
      cover: "first-frame",
      location: "",
    },
  });

  assert.equal(payload.publishUrl, XIAOHONGSHU_PUBLISH_URL);
  assert.equal(payload.testMode, false);
  assert.equal(payload.videoPath, videoPath);
  assert.equal(payload.title, "小红书标题");
  assert.equal(payload.description, "小红书简介");
  assert.deepEqual(payload.hashtags, ["#读书", "#成长", "#生活"]);
  assert.equal(payload.hashtagText, "#读书 #成长 #生活");
  assert.deepEqual(payload.settings.slice(0, 4), [
    { label: "AI 生成内容声明", value: "开启" },
    { label: "原创声明", value: "关闭" },
    { label: "允许下载", value: "关闭" },
    { label: "商业推广", value: "关闭" },
  ]);

  const verificationPayload = validateManualXiaohongshuVerificationPayload({
    ...payload,
    launchedAt: "2026-08-10T06:00:00.000Z",
    account: { name: "测试账号", id: "123456" },
  });
  assert.deepEqual(verificationPayload.account, { name: "测试账号", id: "123456" });
  assert.equal(
    manualXiaohongshuVerificationStatusPath(testRoot, verificationPayload.releaseId),
    path.join(testRoot, ".agents", "manual-publisher", "xiaohongshu", `${verificationPayload.releaseId}.verification.json`),
  );
  const verificationBrief = {
    queuePosition: verificationPayload.queuePosition,
    book: verificationPayload.book,
    releaseId: verificationPayload.releaseId,
    renderSha256: verificationPayload.renderSha256,
    videoPath: verificationPayload.videoPath,
    platformCopy: { xiaohongshu: { title: verificationPayload.title } },
    queueStatus: { xiaohongshu: "pending" },
  };
  assert.deepEqual(
    assertManualXiaohongshuVerificationBrief(verificationPayload, verificationBrief),
    { alreadyPublished: false },
  );
  assert.deepEqual(
    assertManualXiaohongshuVerificationBrief(verificationPayload, {
      ...verificationBrief,
      queueStatus: { xiaohongshu: "published" },
    }),
    { alreadyPublished: true },
  );
  assert.throws(
    () => assertManualXiaohongshuVerificationBrief(verificationPayload, {
      ...verificationBrief,
      renderSha256: "e".repeat(64),
    }),
    /render changed/u,
  );
  assert.equal(
    manualXiaohongshuVerificationFailureStatus(new Error("Xiaohongshu note manager did not show a recent exact-title item")),
    "not_found",
  );
  assert.equal(manualXiaohongshuVerificationFailureStatus(new Error("Xiaohongshu login timed out")), "login_required");

  const shortLivedPanel = spawn(process.execPath, ["-e", "setTimeout(() => {}, 150)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  assert.equal(manualPanelProcessIsRunning(shortLivedPanel.pid), true);
  await waitForManualPanelClose(shortLivedPanel.pid, { pollMilliseconds: 20 });
  assert.equal(manualPanelProcessIsRunning(shortLivedPanel.pid), false);

  const testPayload = buildXiaohongshuManualPayload({
    queuePosition: 1,
    book: "昨日已发布图书",
    releaseId: "c".repeat(64),
    renderSha256: "d".repeat(64),
    videoPath,
    platformCopy: {
      xiaohongshu: {
        title: "测试标题",
        description: "测试简介",
        hashtags: ["#测试一", "#测试二", "#测试三"],
      },
    },
    settings: {},
  }, { testMode: true });
  assert.equal(testPayload.testMode, true);

  fs.writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (process.platform === "win32") {
    const validation = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-STA",
      "-File",
      panelScript,
      "-PayloadPath",
      payloadPath,
      "-SmokeTest",
    ], { encoding: "utf8" });
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
    assert.deepEqual(JSON.parse(validation.stdout.trim()), {
      smokeTest: true,
      topmost: true,
      title: "小红书手动发布 - 测试图书",
      sectionCount: 4,
    });
  }

  const panelSource = fs.readFileSync(panelScript, "utf8");
  assert.match(panelSource, /\$window\.Topmost = \$true/u);
  assert.match(panelSource, /DataFormats\]::FileDrop/u);
  assert.match(panelSource, /New-ActionButton "输入标题"/u);
  assert.match(panelSource, /New-ActionButton "输入简介"/u);
  assert.match(panelSource, /function Set-ClipboardTextWithRetry/u);
  assert.match(panelSource, /for \(\$attempt = 1; \$attempt -le 5; \$attempt \+= 1\)/u);
  assert.match(panelSource, /SendKeys\]::SendWait\("\^v"\)/u);
  assert.match(panelSource, /SendWait\("\{ENTER\}"\)/u);
  assert.match(panelSource, /标签输入未完成/u);
  assert.match(panelSource, /面板会保持打开/u);
  assert.doesNotMatch(panelSource, /ScrollViewer/u);
  assert.doesNotMatch(panelSource, /发布设置/u);
  assert.doesNotMatch(panelSource, /videoHint|tagHint|headerSubtitle/u);
  assert.doesNotMatch(panelSource, /SendWait\("\{DOWN\}\{ENTER\}"\)/u);
  assert.doesNotMatch(panelSource, /playwright/iu);

  const launcherSource = fs.readFileSync(launcherScript, "utf8");
  assert.match(launcherSource, /publicationVerification: "disabled"/u);
  assert.doesNotMatch(launcherSource, /launchVerificationWatcher|--panel-pid/u);
  assert.match(launcherSource, /windowsHide: true/u);

  const verifierSource = fs.readFileSync(verifierScript, "utf8");
  assert.match(verifierSource, /verification_disabled/u);
  assert.match(verifierSource, /disabled by repository policy/u);
  assert.match(verifierSource, /waitForManualPanelClose/u);
  assert.match(verifierSource, /verifyXiaohongshuPublishedWork/u);
  assert.match(verifierSource, /fullPage: false/u);
  assert.match(verifierSource, /markPublishQueuePlatformPublished/u);
  assert.doesNotMatch(verifierSource, /platformPrepareFunction|platformPublishFunction/u);
  const platformPublishersSource = fs.readFileSync(path.resolve(scriptDir, "..", "lib", "platform-publishers.mjs"), "utf8");
  const xiaohongshuVerifierSource = platformPublishersSource.slice(
    platformPublishersSource.indexOf("export async function verifyXiaohongshuPublishedWork"),
  );
  assert.match(xiaohongshuVerifierSource, /recentThreshold = Number\.isFinite\(notBefore\) \? notBefore : null/u);
  assert.doesNotMatch(xiaohongshuVerifierSource, /notBefore - 5 \* 60 \* 1000/u);
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

console.log("manual Xiaohongshu publisher: ok");
