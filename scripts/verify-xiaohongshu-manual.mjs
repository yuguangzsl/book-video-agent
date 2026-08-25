#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { buildPublicationBrief } from "./lib/publication-workflow.mjs";
import { writeFileAtomically } from "./lib/filesystem.mjs";
import {
  assertManualXiaohongshuVerificationBrief,
  manualXiaohongshuVerificationFailureStatus,
  manualXiaohongshuVerificationStatusPath,
  manualPanelProcessIsRunning,
  validateManualXiaohongshuVerificationPayload,
  waitForManualPanelClose,
} from "./lib/manual-xiaohongshu-verification.mjs";
import {
  platformNeedsLogin,
  verifyXiaohongshuPublishedWork,
} from "./lib/platform-publishers.mjs";
import { markPublishQueuePlatformPublished } from "./lib/publish-queue.mjs";
import {
  assertReadOnlyVerificationPlatforms,
  XIAOHONGSHU_POST_CLOSE_VERIFICATION_ENABLED,
} from "./lib/publication-policy.mjs";

const ROOT = process.cwd();
const PUBLISHER_ROOT = path.join(ROOT, ".agents", "browser-publisher");
const CHROME_PROFILE = path.join(PUBLISHER_ROOT, "chrome-profile");
const SCREENSHOT_DIR = path.join(PUBLISHER_ROOT, "screenshots");
const WORKER_LOCK = path.join(PUBLISHER_ROOT, "worker.lock");
const DEFAULT_CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MANAGE_URL = "https://creator.xiaohongshu.com/new/note-manager";
const LOGIN_WAIT_MS = 30 * 60 * 1000;
const LOCK_WAIT_MS = 10 * 60 * 1000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorText(error) {
  return error instanceof Error ? (error.stack || error.message) : String(error);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeStatus(statusPath, current, patch) {
  const next = {
    schemaVersion: 1,
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomically(statusPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
  return next;
}

function activePublisherLock() {
  if (!fs.existsSync(WORKER_LOCK)) return null;
  try {
    const lock = readJson(WORKER_LOCK);
    if (manualPanelProcessIsRunning(Number(lock.pid))) return lock;
  } catch {
    // Invalid or stale locks are removed below.
  }
  fs.rmSync(WORKER_LOCK, { force: true });
  return null;
}

async function acquirePublisherLock(sessionId) {
  fs.mkdirSync(PUBLISHER_ROOT, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const active = activePublisherLock();
    if (!active) {
      try {
        const handle = fs.openSync(WORKER_LOCK, "wx");
        const lock = {
          schemaVersion: 1,
          pid: process.pid,
          sessionId,
          operation: "verify-manual-xiaohongshu",
          startedAt: new Date().toISOString(),
        };
        fs.writeFileSync(handle, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
        fs.closeSync(handle);
        return () => {
          if (!fs.existsSync(WORKER_LOCK)) return;
          try {
            const current = readJson(WORKER_LOCK);
            if (current.pid === process.pid && current.sessionId === sessionId) {
              fs.rmSync(WORKER_LOCK, { force: true });
            }
          } catch {
            // Preserve a lock that cannot be proven to belong to this process.
          }
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    await delay(1000);
  }
  throw new Error("Timed out waiting for the shared browser publisher lock");
}

async function waitForXiaohongshuLogin(page, statusPath, state) {
  if (!await platformNeedsLogin(page, "xiaohongshu")) return state;
  state = writeStatus(statusPath, state, {
    status: "login_required",
    action: "Complete Xiaohongshu login in the dedicated Chrome window; verification will resume automatically",
  });
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    if (!await platformNeedsLogin(page, "xiaohongshu")) {
      return writeStatus(statusPath, state, { status: "verifying", action: "" });
    }
    await delay(2000);
  }
  throw new Error("Xiaohongshu login timed out during read-only verification");
}

function successScreenshotPath(payload) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return path.join(
    SCREENSHOT_DIR,
    `manual-${payload.releaseId.slice(0, 12)}-${timestamp}.xiaohongshu.published.png`,
  );
}

async function verifyAfterPanelClose(payloadPath, panelPid) {
  assertReadOnlyVerificationPlatforms(["xiaohongshu"]);
  const payload = validateManualXiaohongshuVerificationPayload(readJson(payloadPath));
  const statusPath = manualXiaohongshuVerificationStatusPath(ROOT, payload.releaseId);
  let state = writeStatus(statusPath, {}, {
    platform: "xiaohongshu",
    status: "waiting_for_panel_close",
    panelPid,
    queuePosition: payload.queuePosition,
    book: payload.book,
    releaseId: payload.releaseId,
    renderSha256: payload.renderSha256,
    title: payload.title,
    launchedAt: payload.launchedAt,
    action: "Close the manual panel after completing or cancelling publication",
  });
  await waitForManualPanelClose(panelPid);
  state = writeStatus(statusPath, state, {
    status: "verifying",
    panelClosedAt: new Date().toISOString(),
    action: "Checking the official Xiaohongshu note manager for the exact title",
  });

  const brief = buildPublicationBrief(ROOT, {
    position: payload.queuePosition,
    book: payload.book,
  });
  const validation = assertManualXiaohongshuVerificationBrief(payload, brief);
  if (validation.alreadyPublished) {
    writeStatus(statusPath, state, { status: "already_published", action: "" });
    return;
  }

  const sessionId = `manual-xhs-${payload.releaseId.slice(0, 12)}-${Date.now()}`;
  const releasePublisherLock = await acquirePublisherLock(sessionId);
  let context;
  let page;
  try {
    const chromePath = process.env.BOOK_PUBLISHER_CHROME_PATH || DEFAULT_CHROME_PATH;
    assert(fs.existsSync(chromePath), `Chrome executable not found: ${chromePath}`);
    fs.mkdirSync(CHROME_PROFILE, { recursive: true });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const { chromium } = await import("playwright-core");
    context = await chromium.launchPersistentContext(CHROME_PROFILE, {
      executablePath: chromePath,
      headless: false,
      viewport: null,
      acceptDownloads: false,
      args: ["--start-maximized", "--no-first-run", "--no-default-browser-check"],
    });
    page = context.pages()[0] || await context.newPage();
    await page.goto(MANAGE_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    state = await waitForXiaohongshuLogin(page, statusPath, state);
    const listProof = await verifyXiaohongshuPublishedWork(page, brief, payload.account, {
      notBefore: payload.launchedAt,
    });
    const screenshotPath = successScreenshotPath(payload);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    assert(fs.existsSync(screenshotPath), "Xiaohongshu manual publication proof screenshot was not saved");
    const proof = {
      ...listProof,
      releaseId: payload.releaseId,
      renderSha256: payload.renderSha256,
      screenshotPath,
    };
    const queueUpdate = markPublishQueuePlatformPublished(ROOT, {
      book: payload.book,
      platform: "xiaohongshu",
      expectedReleaseId: payload.releaseId,
      expectedRenderSha256: payload.renderSha256,
      proof: {
        ...proof,
        sessionId,
        account: payload.account,
      },
    });
    writeStatus(statusPath, state, {
      status: "published",
      proof,
      queueUpdated: queueUpdate.changed,
      action: "",
    });
  } catch (error) {
    let failureScreenshot = "";
    if (page) {
      failureScreenshot = path.join(SCREENSHOT_DIR, `${sessionId}.xiaohongshu.verification-failed.png`);
      await page.screenshot({ path: failureScreenshot, fullPage: false }).catch(() => {});
      if (!fs.existsSync(failureScreenshot)) failureScreenshot = "";
    }
    writeStatus(statusPath, state, {
      status: manualXiaohongshuVerificationFailureStatus(error),
      error: errorText(error),
      ...(failureScreenshot ? { failureScreenshot } : {}),
      action: "Keep Xiaohongshu pending; do not upload again based on this verification result",
    });
    process.exitCode = 1;
  } finally {
    try {
      if (context) await context.close();
    } finally {
      releasePublisherLock();
    }
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.status === true) {
    const brief = buildPublicationBrief(ROOT, {
      position: args.position === undefined ? undefined : Number(args.position),
      book: args.book,
    });
    const statusPath = manualXiaohongshuVerificationStatusPath(ROOT, brief.releaseId);
    if (!XIAOHONGSHU_POST_CLOSE_VERIFICATION_ENABLED) {
      printJson({
        statusPath,
        status: "verification_disabled",
        queuePosition: brief.queuePosition,
        book: brief.book,
      });
      return;
    }
    printJson(fs.existsSync(statusPath)
      ? { statusPath, ...readJson(statusPath) }
      : { statusPath, status: "not_started", queuePosition: brief.queuePosition, book: brief.book });
    return;
  }
  assert(
    XIAOHONGSHU_POST_CLOSE_VERIFICATION_ENABLED,
    "Xiaohongshu post-close publication verification is disabled by repository policy",
  );
  const payloadPath = path.resolve(String(args.payload || ""));
  const panelPid = Number(args["panel-pid"]);
  assert(fs.existsSync(payloadPath), `Manual Xiaohongshu payload is missing: ${payloadPath}`);
  assert(Number.isInteger(panelPid) && panelPid > 0, "Manual Xiaohongshu verifier requires --panel-pid");
  await verifyAfterPanelClose(payloadPath, panelPid);
}

main().catch((error) => {
  process.stderr.write(`${errorText(error)}\n`);
  process.exitCode = 1;
});
