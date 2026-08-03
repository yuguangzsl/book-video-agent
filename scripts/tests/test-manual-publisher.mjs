import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildXiaohongshuManualPayload,
  XIAOHONGSHU_PUBLISH_URL,
} from "../lib/manual-publisher.mjs";
import {
  assertBrowserAutomationPlatforms,
  BROWSER_AUTOMATION_PLATFORMS,
} from "../lib/publication-policy.mjs";

assert.deepEqual(BROWSER_AUTOMATION_PLATFORMS, ["douyin"]);
assert.deepEqual(assertBrowserAutomationPlatforms(["douyin"]), ["douyin"]);
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
      sectionCount: 5,
    });
  }

  const panelSource = fs.readFileSync(panelScript, "utf8");
  assert.match(panelSource, /\$window\.Topmost = \$true/u);
  assert.match(panelSource, /DataFormats\]::FileDrop/u);
  assert.match(panelSource, /New-ActionButton "输入标题"/u);
  assert.match(panelSource, /New-ActionButton "输入简介"/u);
  assert.match(panelSource, /SendKeys\]::SendWait\("\^v"\)/u);
  assert.match(panelSource, /SendWait\("\{ENTER\}"\)/u);
  assert.doesNotMatch(panelSource, /SendWait\("\{DOWN\}\{ENTER\}"\)/u);
  assert.doesNotMatch(panelSource, /playwright/iu);
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

console.log("manual Xiaohongshu publisher: ok");
