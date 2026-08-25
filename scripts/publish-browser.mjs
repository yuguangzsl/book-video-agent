#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PUBLISH_PLATFORMS,
  buildPublicationBrief,
  commandPath,
  createPublicationSession,
  publicationSessionSummary,
  readPublicationConfirmation,
  readPublicationSession,
  updatePublicationPlatform,
  updatePublicationSession,
  writePublicationConfirmation,
} from "./lib/publication-workflow.mjs";
import {
  openPlatformPreparePage,
  platformNeedsLogin,
  platformPrepareFunction,
  platformPublishFunction,
  verifyDouyinPublishedWork,
  waitForPlatformLogin,
} from "./lib/platform-publishers.mjs";
import { markPublishQueuePlatformPublished } from "./lib/publish-queue.mjs";
import { assertBrowserAutomationPlatforms } from "./lib/publication-policy.mjs";

const ROOT = process.cwd();
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PUBLISHER_ROOT = path.join(ROOT, ".agents", "browser-publisher");
const CHROME_PROFILE = path.join(PUBLISHER_ROOT, "chrome-profile");
const SCREENSHOT_DIR = path.join(PUBLISHER_ROOT, "screenshots");
const LOG_DIR = path.join(PUBLISHER_ROOT, "logs");
const WORKER_LOCK = path.join(PUBLISHER_ROOT, "worker.lock");
const DEFAULT_CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PREPARE_WAIT_MS = 6 * 60 * 60 * 1000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
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

function parsePlatforms(value) {
  const platforms = String(value || "douyin")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  assert(platforms.length > 0, "At least one platform is required");
  assert(platforms.every((platform) => PUBLISH_PLATFORMS.includes(platform)), `Unsupported platforms: ${platforms.join(", ")}`);
  return assertBrowserAutomationPlatforms([...new Set(platforms)]);
}

function parseAccounts(args) {
  return {
    douyin: {
      name: String(args["douyin-account-name"] || "").trim(),
      id: String(args["douyin-account-id"] || "").trim(),
    },
    xiaohongshu: {
      name: String(args["xiaohongshu-account-name"] || "").trim(),
      id: String(args["xiaohongshu-account-id"] || "").trim(),
    },
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errorText(error) {
  return error instanceof Error ? (error.stack || error.message) : String(error);
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function activeWorkerLock() {
  if (!fs.existsSync(WORKER_LOCK)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(WORKER_LOCK, "utf8"));
    if (processIsRunning(Number(lock.pid))) return lock;
  } catch {
    // Invalid or unreadable lock files are treated as stale.
  }
  fs.rmSync(WORKER_LOCK, { force: true });
  return null;
}

function assertPublisherAvailable() {
  const lock = activeWorkerLock();
  assert(!lock, `Browser publisher is already running for session ${lock?.sessionId || "unknown"} (pid ${lock?.pid || "unknown"})`);
}

function acquirePublisherLock(sessionId, operation) {
  fs.mkdirSync(PUBLISHER_ROOT, { recursive: true });
  assertPublisherAvailable();
  const handle = fs.openSync(WORKER_LOCK, "wx");
  const lock = {
    schemaVersion: 1,
    pid: process.pid,
    sessionId,
    operation,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(handle, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  fs.closeSync(handle);
  return () => {
    if (!fs.existsSync(WORKER_LOCK)) return;
    try {
      const current = JSON.parse(fs.readFileSync(WORKER_LOCK, "utf8"));
      if (current.pid !== process.pid || current.sessionId !== sessionId) return;
    } catch {
      return;
    }
    fs.rmSync(WORKER_LOCK, { force: true });
  };
}

function screenshotPath(sessionId, platform) {
  return path.join(SCREENSHOT_DIR, `${sessionId}.${platform}.png`);
}

function successScreenshotPath(sessionId, platform) {
  return path.join(SCREENSHOT_DIR, `${sessionId}.${platform}.published.png`);
}

async function captureFailure(page, sessionId, platform) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const target = screenshotPath(sessionId, platform);
  await page.screenshot({ path: target, fullPage: true }).catch(() => {});
  return fs.existsSync(target) ? target : "";
}

async function capturePublicationProof(page, sessionId, platform) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const target = successScreenshotPath(sessionId, platform);
  await page.screenshot({ path: target, fullPage: platform !== "douyin" });
  assert(fs.existsSync(target), `${platform} publication proof screenshot was not saved`);
  return target;
}

async function preparePlatform(page, session, platform) {
  assertBrowserAutomationPlatforms([platform]);
  updatePublicationPlatform(ROOT, session.id, platform, {
    status: "opening",
    pageUrl: "",
    error: "",
  });
  await openPlatformPreparePage(page, platform);
  updatePublicationPlatform(ROOT, session.id, platform, { pageUrl: page.url() });
  if (await platformNeedsLogin(page, platform)) {
    updatePublicationPlatform(ROOT, session.id, platform, {
      status: "login_required",
      pageUrl: page.url(),
      action: `Complete ${platform} login in the dedicated Chrome window`,
    });
    await waitForPlatformLogin(page, platform);
  }

  updatePublicationPlatform(ROOT, session.id, platform, {
    status: "preparing",
    pageUrl: page.url(),
    action: "",
  });
  const prepare = platformPrepareFunction(platform);
  const review = await prepare(page, session.brief, session.accounts[platform]);
  updatePublicationPlatform(ROOT, session.id, platform, {
    status: "ready",
    pageUrl: page.url(),
    review,
    action: "Awaiting final publication confirmation",
  });
}

function revalidatePreparedRelease(session, platform) {
  const current = buildPublicationBrief(ROOT, {
    position: session.brief.queuePosition,
    book: session.brief.book,
  });
  assert(current.releaseId === session.brief.releaseId, `${platform} release changed after browser preparation`);
  assert(current.renderSha256 === session.brief.renderSha256, `${platform} render changed after browser preparation`);
  assert(current.videoPath === session.brief.videoPath, `${platform} immutable release video path changed`);
  const expectedQueueStatus = session.repostTest === true ? "published" : "pending";
  assert(
    current.queueStatus[platform] === expectedQueueStatus,
    `${platform} queue status is no longer ${expectedQueueStatus}`,
  );
  assert(
    JSON.stringify(current.platformCopy[platform]) === JSON.stringify(session.brief.platformCopy[platform]),
    `${platform} publication copy changed after browser preparation`,
  );
  return current;
}

async function publishPlatform(page, sessionId, platform) {
  assertBrowserAutomationPlatforms([platform]);
  let session = readPublicationSession(ROOT, sessionId);
  const confirmation = readPublicationConfirmation(ROOT, sessionId, platform);
  assert(confirmation, `Missing final confirmation for ${platform}`);
  assert(
    confirmation.releaseId === session.brief.releaseId,
    `${platform} final confirmation release does not match the prepared release`,
  );
  assert(
    confirmation.renderSha256 === session.brief.renderSha256,
    `${platform} final confirmation hash does not match the prepared render`,
  );
  revalidatePreparedRelease(session, platform);
  updatePublicationPlatform(ROOT, sessionId, platform, {
    status: "publishing",
    action: "",
    confirmation: {
      confirmedAt: confirmation.confirmedAt,
      releaseId: confirmation.releaseId,
      renderSha256: confirmation.renderSha256,
    },
  });

  const publish = platformPublishFunction(platform);
  const acceptedProof = {
    ...await publish(page, session.brief, session.accounts[platform]),
    releaseId: session.brief.releaseId,
    renderSha256: session.brief.renderSha256,
  };
  updatePublicationPlatform(ROOT, sessionId, platform, {
    status: "submission_unknown",
    pageUrl: page.url(),
    proof: acceptedProof,
    action: "Platform accepted the submission; verifying the official list",
  });
  const verify = verifyDouyinPublishedWork;
  let proof;
  try {
    proof = {
      ...acceptedProof,
      ...await verify(page, session.brief, session.accounts[platform], {
        notBefore: confirmation.confirmedAt,
      }),
    };
  } catch (error) {
    updatePublicationPlatform(ROOT, sessionId, platform, {
      status: "submission_unknown",
      pageUrl: page.url(),
      proof: acceptedProof,
      error: errorText(error),
      action: `Run verify before any retry; do not republish ${platform}`,
    });
    return;
  }
  updatePublicationPlatform(ROOT, sessionId, platform, {
    status: "published_unrecorded",
    pageUrl: page.url(),
    proof,
    error: "",
    action: "Official list verified; saving proof screenshot",
  });
  try {
    proof = {
      ...proof,
      screenshotPath: await capturePublicationProof(page, sessionId, platform),
    };
  } catch (error) {
    updatePublicationPlatform(ROOT, sessionId, platform, {
      status: "published_unrecorded",
      pageUrl: page.url(),
      proof,
      error: errorText(error),
      action: `Run verify to capture proof; do not republish ${platform}`,
    });
    return;
  }
  updatePublicationPlatform(ROOT, sessionId, platform, {
    status: "published_unrecorded",
    pageUrl: page.url(),
    proof,
    error: "",
    action: "Official list and screenshot verified; recording queue status",
  });
  if (session.repostTest === true) {
    updatePublicationPlatform(ROOT, sessionId, platform, {
      status: "published",
      pageUrl: page.url(),
      proof,
      queueUpdated: false,
      testRepost: true,
      error: "",
      action: "",
    });
    return;
  }
  try {
    const queueUpdate = markPublishQueuePlatformPublished(ROOT, {
      book: session.brief.book,
      platform,
      expectedReleaseId: session.brief.releaseId,
      expectedRenderSha256: session.brief.renderSha256,
      proof: {
        ...proof,
        sessionId: session.id,
        account: session.accounts?.[platform],
        confirmedAt: session.platforms[platform].confirmation?.confirmedAt,
      },
    });
    updatePublicationPlatform(ROOT, sessionId, platform, {
      status: "published",
      pageUrl: page.url(),
      proof,
      queueUpdated: queueUpdate.changed,
      action: "",
    });
  } catch (error) {
    updatePublicationPlatform(ROOT, sessionId, platform, {
      status: "published_unrecorded",
      pageUrl: page.url(),
      proof,
      error: errorText(error),
      action: `Run record after resolving the queue error; do not republish ${platform}`,
    });
  }
}

async function runWorker(sessionId) {
  let session = readPublicationSession(ROOT, sessionId);
  assertBrowserAutomationPlatforms(session.requestedPlatforms);
  updatePublicationSession(ROOT, session.id, (next) => ({
    ...next,
    worker: { pid: process.pid, startedAt: new Date().toISOString() },
  }));

  const chromePath = process.env.BOOK_PUBLISHER_CHROME_PATH || DEFAULT_CHROME_PATH;
  assert(fs.existsSync(chromePath), `Chrome executable not found: ${chromePath}`);
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  const { chromium } = await import("playwright-core");
  const releasePublisherLock = acquirePublisherLock(sessionId, "prepare-and-publish");
  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE, {
      executablePath: chromePath,
      headless: false,
      viewport: null,
      acceptDownloads: false,
      args: ["--start-maximized", "--no-first-run", "--no-default-browser-check"],
    });
  } catch (error) {
    releasePublisherLock();
    throw error;
  }
  const pages = new Map();

  try {
    const initialPages = context.pages();
    for (const [index, platform] of session.requestedPlatforms.entries()) {
      const page = index === 0 && initialPages[0] ? initialPages[0] : await context.newPage();
      pages.set(platform, page);
      try {
        await preparePlatform(page, session, platform);
      } catch (error) {
        const failureScreenshot = await captureFailure(page, session.id, platform);
        updatePublicationPlatform(ROOT, session.id, platform, {
          status: "failed",
          pageUrl: page.url(),
          error: errorText(error),
          ...(failureScreenshot ? { failureScreenshot } : {}),
          action: "Fix the visible form or selector issue before starting a new session",
        });
      }
      session = readPublicationSession(ROOT, session.id);
    }

    const confirmationDeadline = Date.now() + PREPARE_WAIT_MS;
    while (Date.now() < confirmationDeadline) {
      session = readPublicationSession(ROOT, session.id);
      const ready = session.requestedPlatforms.filter((platform) => session.platforms[platform].status === "ready");
      if (ready.length === 0) break;

      for (const platform of ready) {
        const confirmation = readPublicationConfirmation(ROOT, session.id, platform);
        if (!confirmation) continue;
        const page = pages.get(platform);
        try {
          await publishPlatform(page, session.id, platform);
        } catch (error) {
          const failureScreenshot = await captureFailure(page, session.id, platform);
          const latest = readPublicationSession(ROOT, session.id);
          const submissionStarted = latest.platforms[platform].status === "publishing";
          updatePublicationPlatform(ROOT, session.id, platform, {
            status: submissionStarted ? "submission_unknown" : "failed",
            pageUrl: page.url(),
            error: errorText(error),
            ...(failureScreenshot ? { failureScreenshot } : {}),
            action: submissionStarted
              ? "Submission outcome is unknown; run verify and do not republish"
              : "Preparation became stale before submission; start a new session",
          });
        }
      }
      await delay(1000);
    }

    session = readPublicationSession(ROOT, session.id);
    for (const platform of session.requestedPlatforms) {
      if (session.platforms[platform].status === "ready") {
        updatePublicationPlatform(ROOT, session.id, platform, {
          status: "cancelled",
          action: "Final confirmation timed out; prepare again before publishing",
        });
      }
    }
  } finally {
    try {
      await context.close();
      updatePublicationSession(ROOT, session.id, (next) => ({
        ...next,
        worker: {
          ...(next.worker || {}),
          stoppedAt: new Date().toISOString(),
        },
      }));
    } finally {
      releasePublisherLock();
    }
  }
}

function startWorker(session) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stdoutPath = path.join(LOG_DIR, `${session.id}.stdout.log`);
  const stderrPath = path.join(LOG_DIR, `${session.id}.stderr.log`);
  const stdoutHandle = fs.openSync(stdoutPath, "a");
  const stderrHandle = fs.openSync(stderrPath, "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "worker", "--session", session.id], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdoutHandle, stderrHandle],
  });
  child.unref();
  fs.closeSync(stdoutHandle);
  fs.closeSync(stderrHandle);
  updatePublicationSession(ROOT, session.id, (next) => ({
    ...next,
    worker: {
      pid: child.pid,
      spawnedAt: new Date().toISOString(),
      stdoutPath,
      stderrPath,
    },
  }));
  return { pid: child.pid, stdoutPath, stderrPath };
}

function recordPublishedPlatform(sessionId, platform, expectedRenderSha256) {
  const session = readPublicationSession(ROOT, sessionId);
  assert(session.repostTest !== true, "Test repost sessions never update the publication queue");
  const state = session.platforms[platform];
  assert(state.status === "published_unrecorded", `${platform} does not have an unrecorded verified publication`);
  assert(state.proof, `${platform} publication proof is missing`);
  assert(session.brief.renderSha256 === String(expectedRenderSha256 || "").trim().toLowerCase(), "Record SHA does not match session render");
  const result = markPublishQueuePlatformPublished(ROOT, {
    book: session.brief.book,
    platform,
    expectedReleaseId: session.brief.releaseId,
    expectedRenderSha256: session.brief.renderSha256,
    proof: {
      ...state.proof,
      sessionId: session.id,
      account: session.accounts?.[platform],
      confirmedAt: state.confirmation?.confirmedAt,
    },
  });
  updatePublicationPlatform(ROOT, session.id, platform, {
    status: "published",
    queueUpdated: result.changed,
    error: "",
    action: "",
  });
  return result;
}

async function verifyPublishedPlatform(sessionId, platform) {
  assert(PUBLISH_PLATFORMS.includes(platform), `Unsupported publication verification platform: ${platform}`);
  assertBrowserAutomationPlatforms([platform]);
  const session = readPublicationSession(ROOT, sessionId);
  const state = session.platforms[platform];
  const revalidatingTestProof = session.repostTest === true && state.status === "published";
  assert(
    ["failed", "submission_unknown", "published_unrecorded"].includes(state.status) || revalidatingTestProof,
    `${platform} verification requires failed, submission_unknown, published_unrecorded, or a published test repost`,
  );
  const confirmation = readPublicationConfirmation(ROOT, session.id, platform);
  assert(confirmation, `Missing final confirmation for ${platform}`);
  assert(
    confirmation.releaseId === session.brief.releaseId,
    `${platform} final confirmation release does not match the prepared release`,
  );
  assert(
    confirmation.renderSha256 === session.brief.renderSha256,
    `${platform} final confirmation hash does not match the prepared render`,
  );
  if (revalidatingTestProof) {
    updatePublicationPlatform(ROOT, session.id, platform, {
      status: "submission_unknown",
      error: "",
      action: "Revalidating the test repost against the official list",
    });
  }

  const chromePath = process.env.BOOK_PUBLISHER_CHROME_PATH || DEFAULT_CHROME_PATH;
  assert(fs.existsSync(chromePath), `Chrome executable not found: ${chromePath}`);
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  const { chromium } = await import("playwright-core");
  const releasePublisherLock = acquirePublisherLock(session.id, `verify-${platform}`);
  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE, {
      executablePath: chromePath,
      headless: false,
      viewport: null,
      acceptDownloads: false,
      args: ["--start-maximized", "--no-first-run", "--no-default-browser-check"],
    });
    const page = context.pages()[0] || await context.newPage();
    const verify = verifyDouyinPublishedWork;
    let proof = {
      ...(state.proof || {}),
      ...await verify(page, session.brief, session.accounts[platform], {
        notBefore: confirmation.confirmedAt,
      }),
      releaseId: session.brief.releaseId,
      renderSha256: session.brief.renderSha256,
    };
    updatePublicationPlatform(ROOT, session.id, platform, {
      status: "published_unrecorded",
      pageUrl: page.url(),
      proof,
      error: "",
      action: "Official list verified; saving proof screenshot",
    });
    proof = {
      ...proof,
      screenshotPath: await capturePublicationProof(page, session.id, platform),
    };
    updatePublicationPlatform(ROOT, session.id, platform, {
      status: "published_unrecorded",
      pageUrl: page.url(),
      proof,
      error: "",
      action: "Official list and screenshot verified; recording queue status",
    });
    if (session.repostTest === true) {
      updatePublicationPlatform(ROOT, session.id, platform, {
        status: "published",
        pageUrl: page.url(),
        proof,
        queueUpdated: false,
        testRepost: true,
        error: "",
        action: "",
      });
      return { proof, queueUpdated: false, testRepost: true };
    }
    try {
      const queueUpdate = markPublishQueuePlatformPublished(ROOT, {
        book: session.brief.book,
        platform,
        expectedReleaseId: session.brief.releaseId,
        expectedRenderSha256: session.brief.renderSha256,
        proof: {
          ...proof,
          sessionId: session.id,
          account: session.accounts?.[platform],
          confirmedAt: confirmation.confirmedAt,
        },
      });
      updatePublicationPlatform(ROOT, session.id, platform, {
        status: "published",
        pageUrl: page.url(),
        proof,
        queueUpdated: queueUpdate.changed,
        error: "",
        action: "",
      });
      return { proof, queueUpdated: queueUpdate.changed };
    } catch (error) {
      updatePublicationPlatform(ROOT, session.id, platform, {
        status: "published_unrecorded",
        pageUrl: page.url(),
        proof,
        error: errorText(error),
        action: `Run record after resolving the queue error; do not republish ${platform}`,
      });
      throw error;
    }
  } finally {
    try {
      if (context) await context.close();
    } finally {
      releasePublisherLock();
    }
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/publish-browser.mjs brief --position <n>",
    "  node scripts/publish-browser.mjs start --position <n> [--platforms douyin] [--repost-test] --douyin-account-name <name> --douyin-account-id <id>",
    "  node scripts/publish-browser.mjs status [--session <id>]",
    "  node scripts/publish-browser.mjs confirm --platform <name|all> --confirm-sha <sha> [--session <id>]",
    "  node scripts/publish-browser.mjs acknowledge-manual --platform douyin --confirm-sha <sha> [--session <id>]",
    "  node scripts/publish-browser.mjs verify --platform douyin [--session <id>]",
    "  node scripts/publish-browser.mjs record --platform <name> --confirm-sha <sha> [--session <id>]",
  ].join("\n");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "brief") {
    printJson(buildPublicationBrief(ROOT, { position: Number(args.position), book: args.book }));
    return;
  }
  if (command === "start") {
    assertPublisherAvailable();
    const platforms = parsePlatforms(args.platforms);
    const session = createPublicationSession(ROOT, {
      position: Number(args.position),
      book: args.book,
      platforms,
      repostTest: args["repost-test"] === true,
      accounts: parseAccounts(args),
    });
    const worker = startWorker(session);
    printJson({ ...publicationSessionSummary(readPublicationSession(ROOT, session.id)), worker });
    return;
  }
  if (command === "worker") {
    assert(args.session, "worker requires --session");
    await runWorker(String(args.session));
    return;
  }
  if (command === "status") {
    printJson(publicationSessionSummary(readPublicationSession(ROOT, args.session)));
    return;
  }
  if (command === "confirm") {
    const session = readPublicationSession(ROOT, args.session);
    const platforms = args.platform === "all" ? session.requestedPlatforms : [String(args.platform || "")];
    assert(platforms.every((platform) => PUBLISH_PLATFORMS.includes(platform)), "confirm requires --platform <name|all>");
    assertBrowserAutomationPlatforms(platforms);
    const results = platforms.map((platform) => writePublicationConfirmation(
      ROOT,
      session.id,
      platform,
      args["confirm-sha"],
    ));
    printJson({ sessionId: session.id, confirmed: results.map((result) => result.command.platform) });
    return;
  }
  if (command === "acknowledge-manual") {
    assert(args.platform === "douyin", "acknowledge-manual requires --platform douyin");
    const session = readPublicationSession(ROOT, args.session);
    assert(session.repostTest !== true, "Test repost sessions cannot acknowledge a manual submission");
    assert(session.requestedPlatforms.includes(args.platform), `${args.platform} was not requested in session ${session.id}`);
    assert(session.platforms[args.platform].status === "ready", `${args.platform} is not ready for manual submission acknowledgement`);
    const normalizedSha = String(args["confirm-sha"] || "").trim().toLowerCase();
    assert(normalizedSha === session.brief.renderSha256, "Manual submission SHA does not match the prepared render");
    const reportedAt = new Date().toISOString();
    updatePublicationPlatform(ROOT, session.id, args.platform, {
      status: "cancelled",
      manualSubmission: {
        reportedAt,
        releaseId: session.brief.releaseId,
        renderSha256: normalizedSha,
      },
      error: "",
      action: "Manual submission reported; stopping the preparer before read-only verification",
    });
    const stopDeadline = Date.now() + 30000;
    let stopped = readPublicationSession(ROOT, session.id).worker?.stoppedAt || "";
    while (!stopped && Date.now() < stopDeadline) {
      await delay(250);
      stopped = readPublicationSession(ROOT, session.id).worker?.stoppedAt || "";
    }
    assert(stopped, "Publisher worker did not stop before manual-submission verification");
    const confirmation = writePublicationConfirmation(
      ROOT,
      session.id,
      args.platform,
      normalizedSha,
      { now: reportedAt, manualSubmission: true },
    );
    updatePublicationPlatform(ROOT, session.id, args.platform, {
      status: "submission_unknown",
      proof: {
        acceptedSignal: "user reported manual submission from the prepared official form",
        submittedAt: reportedAt,
        releaseId: session.brief.releaseId,
        renderSha256: normalizedSha,
      },
      error: "",
      action: "Manual submission reported; verify the official list without republishing",
    });
    printJson({
      sessionId: session.id,
      platform: args.platform,
      acknowledged: true,
      reportedAt: confirmation.command.confirmedAt,
      renderSha256: confirmation.command.renderSha256,
    });
    return;
  }
  if (command === "verify") {
    assert(PUBLISH_PLATFORMS.includes(args.platform), "verify requires --platform douyin");
    assertBrowserAutomationPlatforms([args.platform]);
    const session = readPublicationSession(ROOT, args.session);
    const result = await verifyPublishedPlatform(session.id, args.platform);
    printJson({ sessionId: session.id, platform: args.platform, ...result });
    return;
  }
  if (command === "record") {
    assert(PUBLISH_PLATFORMS.includes(args.platform), "record requires --platform <name>");
    const session = readPublicationSession(ROOT, args.session);
    const result = recordPublishedPlatform(session.id, args.platform, args["confirm-sha"]);
    printJson({ sessionId: session.id, platform: args.platform, changed: result.changed });
    return;
  }
  if (command === "paths") {
    const session = readPublicationSession(ROOT, args.session);
    printJson({
      profile: CHROME_PROFILE,
      confirmationFiles: Object.fromEntries(session.requestedPlatforms.map((platform) => [
        platform,
        commandPath(ROOT, session.id, platform),
      ])),
    });
    return;
  }
  throw new Error(usage());
}

main().catch((error) => {
  process.stderr.write(`${errorText(error)}\n`);
  process.exitCode = 1;
});
