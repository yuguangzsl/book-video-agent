export const BROWSER_AUTOMATION_PLATFORMS = ["douyin"];
export const XIAOHONGSHU_POST_CLOSE_VERIFICATION_ENABLED = false;
export const XIAOHONGSHU_STATUS_SOURCE = "douyin";
export const READ_ONLY_VERIFICATION_PLATFORMS = ["douyin"];
export const PUBLICATION_COMPLETION_REQUIRED_PLATFORMS = ["douyin"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertBrowserAutomationPlatforms(platforms) {
  assert(Array.isArray(platforms) && platforms.length > 0, "At least one browser automation platform is required");
  const unsupported = platforms.filter((platform) => !BROWSER_AUTOMATION_PLATFORMS.includes(platform));
  assert(
    unsupported.length === 0,
    `Browser automation is disabled for ${unsupported.join(", ")}; use npm run publish:xiaohongshu for manual Xiaohongshu publication`,
  );
  return platforms;
}

export function assertReadOnlyVerificationPlatforms(platforms) {
  assert(Array.isArray(platforms) && platforms.length > 0, "At least one read-only verification platform is required");
  const unsupported = platforms.filter((platform) => !READ_ONLY_VERIFICATION_PLATFORMS.includes(platform));
  assert(
    unsupported.length === 0,
    `Read-only publication verification is disabled for ${unsupported.join(", ")}`,
  );
  return platforms;
}

export function publicationStatusBlocksCompletion(platform, status) {
  return status === "pending" && PUBLICATION_COMPLETION_REQUIRED_PLATFORMS.includes(platform);
}

export function effectivePublicationStatus(platform, statuses) {
  assert(statuses && typeof statuses === "object", "Publication statuses are required");
  if (platform === "xiaohongshu") return statuses.douyin;
  return statuses[platform];
}
