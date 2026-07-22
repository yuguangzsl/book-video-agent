export const CAPTION_LEAD_SECONDS = 0.5;
export const MAX_CAPTION_CLAUSE_CHARS = 12;

export function wrapCaptionLines(text, maxClauseChars = MAX_CAPTION_CLAUSE_CHARS) {
  if (!Number.isInteger(maxClauseChars) || maxClauseChars <= 0) {
    throw new Error(`maxClauseChars must be a positive integer: ${maxClauseChars}`);
  }
  const clauses = [];
  let current = "";
  for (const char of Array.from(String(text || "").trim())) {
    current += char;
    if (/[，。！？；：,.!?;:]/u.test(char)) {
      clauses.push(current);
      current = "";
    }
  }
  if (current) clauses.push(current);

  return clauses.flatMap((clause) => {
    const chars = Array.from(clause);
    if (chars.length <= maxClauseChars) return [clause];
    const chunkCount = Math.ceil(chars.length / maxClauseChars);
    const chunkSize = Math.ceil(chars.length / chunkCount);
    return Array.from({ length: chunkCount }, (_, index) =>
      chars.slice(index * chunkSize, (index + 1) * chunkSize).join(""),
    );
  });
}

export function buildCaptionPresentationTiming(audioTiming, options = {}) {
  const leadSeconds = options.leadSeconds ?? CAPTION_LEAD_SECONDS;
  const minimumHoldSeconds = options.minimumHoldSeconds ?? 0.8;
  const speechStart = Math.max(0, Number(audioTiming?.start));
  const speechEnd = Math.max(speechStart + minimumHoldSeconds, Number(audioTiming?.end));
  if (!Number.isFinite(speechStart) || !Number.isFinite(speechEnd)) {
    throw new Error("Caption audio timing must contain finite start and end values");
  }
  const start = Math.max(0, speechStart - leadSeconds);
  return {
    start: Number(start.toFixed(2)),
    hold: Number(Math.max(minimumHoldSeconds, speechEnd - start).toFixed(2)),
  };
}

export function buildCaptionInspectTimes(captions, duration) {
  const maximum = Math.max(0, Number(duration) - 0.01);
  return [...new Set((captions || []).map((caption) => {
    const speechStart = Number(caption?.start);
    if (!Number.isFinite(speechStart) || speechStart < 0) {
      throw new Error(`Caption ${caption?.order || "unknown"} has an invalid start time`);
    }
    return Number(Math.min(maximum, speechStart).toFixed(2));
  }))];
}
