export const BROWSER_AUTOMATION_PLATFORMS = ["douyin"];

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
