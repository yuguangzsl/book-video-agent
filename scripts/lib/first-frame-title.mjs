export const DEFAULT_FIRST_FRAME_TITLE_HOLD_SECONDS = 1.2;
export const DEFAULT_FIRST_FRAME_TITLE_SOURCE_SECONDS = 0;

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
