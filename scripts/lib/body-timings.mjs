function roundSeconds(value) {
  return Number(Number(value).toFixed(2));
}

export function parseSilenceEvents(output) {
  const events = [];
  const pattern = /silence_(start|end):\s*([0-9.]+)/gu;
  for (const match of String(output).matchAll(pattern)) {
    events.push({ type: match[1], time: Number(match[2]) });
  }
  return events;
}

export function buildSpeechSegments(duration, events) {
  const segments = [];
  let speechStart = 0;
  let inSilence = false;

  for (const event of events) {
    if (!Number.isFinite(event.time)) continue;
    if (event.type === "start" && !inSilence) {
      if (event.time > speechStart) segments.push({ start: speechStart, end: event.time });
      inSilence = true;
    } else if (event.type === "end" && inSilence) {
      speechStart = event.time;
      inSilence = false;
    }
  }

  if (!inSilence && duration > speechStart) segments.push({ start: speechStart, end: duration });
  return segments.filter((segment) => segment.end - segment.start >= 0.08);
}

export function coalesceSpeechSegments(segments, targetCount) {
  const result = segments.map((segment) => ({ ...segment }));
  while (result.length > targetCount) {
    let mergeIndex = 0;
    let shortestGap = Number.POSITIVE_INFINITY;
    for (let index = 0; index < result.length - 1; index += 1) {
      const gap = result[index + 1].start - result[index].end;
      if (gap < shortestGap) {
        shortestGap = gap;
        mergeIndex = index;
      }
    }
    result.splice(mergeIndex, 2, {
      start: result[mergeIndex].start,
      end: result[mergeIndex + 1].end,
    });
  }
  return result;
}

export function normalizeAlignmentText(value) {
  return String(value || "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
}

export function assertTtsUnitsMatchScript(ttsUnits, scriptTexts, skipLeading = 1) {
  const startIndex = Math.max(0, Number(skipLeading) || 0);
  const bodyUnits = ttsUnits.slice(startIndex);
  if (bodyUnits.length !== scriptTexts.length) {
    throw new Error(`TTS body unit count mismatch: found ${bodyUnits.length}, need ${scriptTexts.length}`);
  }
  bodyUnits.forEach((unit, index) => {
    if (normalizeAlignmentText(unit) !== normalizeAlignmentText(scriptTexts[index])) {
      throw new Error(`TTS input unit ${index + 1} does not match script.csv row ${index + 1}`);
    }
  });
}

function buildTextAlignedSegments(items, expectedTexts) {
  const characters = [];

  for (const item of items || []) {
    const start = Number(item?.start) / 1000;
    const end = Number(item?.end) / 1000;
    const text = normalizeAlignmentText(item?.part);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;

    const characterDuration = (end - start) / text.length;
    [...text].forEach((character, index) => {
      characters.push({
        character,
        start: start + characterDuration * index,
        end: start + characterDuration * (index + 1),
      });
    });
  }

  const units = expectedTexts.map(normalizeAlignmentText);
  if (units.some((unit) => !unit)) throw new Error("TTS input contains an empty text unit");

  const observed = characters.map((item) => item.character).join("");
  const expected = units.join("");
  if (observed !== expected) {
    throw new Error("Edge TTS word boundaries do not match the TTS input text");
  }

  let cursor = 0;
  return units.map((unit) => {
    const first = characters[cursor];
    const last = characters[cursor + unit.length - 1];
    cursor += unit.length;
    return { start: first.start, end: last.end };
  });
}

export function buildEdgeSubtitleSegments(items, expectedTexts = null) {
  if (Array.isArray(expectedTexts) && expectedTexts.length) {
    return buildTextAlignedSegments(items, expectedTexts);
  }

  const segments = [];
  let current = null;

  for (const item of items || []) {
    const start = Number(item?.start) / 1000;
    const end = Number(item?.end) / 1000;
    const part = String(item?.part || "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (!current) current = { start, end };
    else current.end = end;

    if (/[。！？!?；;]\s*$/u.test(part)) {
      segments.push(current);
      current = null;
    }
  }

  if (current) segments.push(current);
  return segments;
}

export function buildCaptionTimings(orders, speechSegments, skipLeading = 1) {
  const startIndex = Number(skipLeading);
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error(`skipLeading must be a non-negative integer: ${skipLeading}`);
  }
  const selected = speechSegments.slice(startIndex, startIndex + orders.length);
  if (selected.length !== orders.length) {
    throw new Error(
      `Speech segment count mismatch: found ${speechSegments.length}, need ${orders.length + startIndex} ` +
      `(including skip-leading=${startIndex}). Adjust --skip-leading or the silence settings.`,
    );
  }

  return selected.map((segment, index) => ({
    order: Number(orders[index]),
    start: roundSeconds(segment.start),
    end: roundSeconds(segment.end),
  }));
}

export function normalizeTimingOptions(options = {}) {
  const skipLeading = Number(options.skipLeading ?? 1);
  const silenceDuration = Number(options.silenceDuration ?? 0.18);
  const noise = String(options.noise ?? "-35dB");
  if (!Number.isInteger(skipLeading) || skipLeading < 0) {
    throw new Error(`Invalid --skip-leading: ${options.skipLeading}`);
  }
  if (!Number.isFinite(silenceDuration) || silenceDuration <= 0) {
    throw new Error(`Invalid --silence-duration: ${options.silenceDuration}`);
  }
  if (!/^-?\d+(?:\.\d+)?dB$/iu.test(noise)) {
    throw new Error(`Invalid --noise: ${options.noise}`);
  }
  return { ...options, skipLeading, silenceDuration, noise };
}

export function validateCaptionTimings(captions, orders, duration) {
  if (!Array.isArray(captions)) throw new Error("body-timings.json captions must be an array");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("body-timings.json duration must be positive");
  if (captions.length !== orders.length) {
    throw new Error(`Caption timing count mismatch: found ${captions.length}, need ${orders.length}`);
  }

  let previousEnd = 0;
  captions.forEach((caption, index) => {
    const order = Number(caption?.order);
    const start = Number(caption?.start);
    const end = Number(caption?.end);
    if (order !== Number(orders[index])) {
      throw new Error(`Caption timing order mismatch at index ${index}: found ${order}, need ${orders[index]}`);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`Caption timing ${order} has an invalid range: ${caption?.start}-${caption?.end}`);
    }
    if (start < previousEnd - 0.01) throw new Error(`Caption timing ${order} overlaps the previous caption`);
    if (end > duration + 0.05) throw new Error(`Caption timing ${order} ends after the voiceover duration`);
    previousEnd = end;
  });
  return captions;
}
