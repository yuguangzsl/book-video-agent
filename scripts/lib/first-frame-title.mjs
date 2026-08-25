export const DEFAULT_FIRST_FRAME_TITLE_HOLD_SECONDS = 1.2;
export const DEFAULT_FIRST_FRAME_TITLE_SOURCE_SECONDS = 0;

export function buildFirstFrameCoverSourceCandidates(
  preferredSourceSeconds,
  bodyDurationSeconds,
  frameDurationSeconds = 1 / 30,
) {
  const duration = Number(bodyDurationSeconds);
  const maximum = duration - Number(frameDurationSeconds);
  if (!Number.isFinite(duration) || !Number.isFinite(maximum) || maximum < 0) return [];
  const preferred = Number(preferredSourceSeconds);
  const fallbacks = [
    0.9,
    1.5,
    2.5,
    4,
    6,
    duration * 0.25,
    duration * 0.5,
    duration * 0.75,
  ].sort((a, b) => a - b);
  const candidates = [preferred, ...fallbacks];
  const seen = new Set();
  return candidates
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= maximum)
    .map((value) => Number(value.toFixed(3)))
    .filter((value) => {
      const key = value.toFixed(3);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

export function resolveFirstFrameTitleConfig(brief) {
  const holdSeconds = Number(
    hasOwn(brief, "firstFrameTitleHoldSeconds")
      ? brief.firstFrameTitleHoldSeconds
      : DEFAULT_FIRST_FRAME_TITLE_HOLD_SECONDS,
  );
  const sourceSeconds = Number(
    hasOwn(brief, "firstFrameTitleSourceSeconds")
      ? brief.firstFrameTitleSourceSeconds
      : DEFAULT_FIRST_FRAME_TITLE_SOURCE_SECONDS,
  );
  return { holdSeconds, sourceSeconds };
}
