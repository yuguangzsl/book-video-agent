import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function manualPanelProcessIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export async function waitForManualPanelClose(pid, options = {}) {
  assert(Number.isInteger(pid) && pid > 0, "Manual panel pid must be a positive integer");
  const pollMilliseconds = Number(options.pollMilliseconds || 500);
  assert(Number.isFinite(pollMilliseconds) && pollMilliseconds > 0, "Manual panel poll interval must be positive");
  while (manualPanelProcessIsRunning(pid)) {
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }
}

export function manualXiaohongshuVerificationStatusPath(root, releaseId) {
  assert(/^[a-f0-9]{64}$/u.test(String(releaseId || "")), "Manual Xiaohongshu verification releaseId is invalid");
  return path.join(root, ".agents", "manual-publisher", "xiaohongshu", `${releaseId}.verification.json`);
}

export function validateManualXiaohongshuVerificationPayload(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "Manual Xiaohongshu verification payload is required");
  assert(value.schemaVersion === 1, "Unsupported manual Xiaohongshu verification payload schema");
  assert(value.platform === "xiaohongshu", "Manual verification payload is not for Xiaohongshu");
  assert(value.testMode !== true, "Test-mode Xiaohongshu panels must not trigger official-list verification");
  assert(Number.isInteger(Number(value.queuePosition)) && Number(value.queuePosition) > 0, "Manual verification queuePosition is invalid");
  assert(/^[a-f0-9]{64}$/u.test(String(value.releaseId || "")), "Manual verification releaseId is invalid");
  assert(/^[a-f0-9]{64}$/u.test(String(value.renderSha256 || "")), "Manual verification renderSha256 is invalid");
  assert(typeof value.videoPath === "string" && path.isAbsolute(value.videoPath), "Manual verification videoPath must be absolute");
  assert(typeof value.title === "string" && value.title.trim(), "Manual verification title is required");
  assert(Number.isFinite(Date.parse(String(value.launchedAt || ""))), "Manual verification launchedAt must be an ISO date");
  const account = {
    name: String(value.account?.name || "").trim(),
    id: String(value.account?.id || "").trim(),
  };
  assert(account.name || account.id, "Manual verification requires the expected Xiaohongshu account name or id");
  return {
    ...value,
    queuePosition: Number(value.queuePosition),
    account,
  };
}

export function assertManualXiaohongshuVerificationBrief(payload, brief) {
  assert(brief && typeof brief === "object", "Current publication brief is required for manual verification");
  assert(brief.queuePosition === payload.queuePosition, "Xiaohongshu verification queue position changed after panel launch");
  assert(brief.book === payload.book, "Xiaohongshu verification book changed after panel launch");
  assert(brief.releaseId === payload.releaseId, "Xiaohongshu verification release changed after panel launch");
  assert(brief.renderSha256 === payload.renderSha256, "Xiaohongshu verification render changed after panel launch");
  assert(brief.videoPath === payload.videoPath, "Xiaohongshu immutable release video changed after panel launch");
  assert(brief.platformCopy?.xiaohongshu?.title === payload.title, "Xiaohongshu verification title changed after panel launch");
  assert(
    ["pending", "published"].includes(brief.queueStatus?.xiaohongshu),
    `Xiaohongshu verification requires pending or published queue status, found ${brief.queueStatus?.xiaohongshu || "missing"}`,
  );
  return { alreadyPublished: brief.queueStatus.xiaohongshu === "published" };
}

export function manualXiaohongshuVerificationFailureStatus(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/did not show.*exact[- ]title/iu.test(message)) return "not_found";
  if (/login|expected account|does not show the expected account/iu.test(message)) return "login_required";
  return "failed";
}
