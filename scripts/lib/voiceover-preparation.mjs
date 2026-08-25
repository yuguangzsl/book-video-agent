export const DEFAULT_TTS_OPTIONS = Object.freeze({
  voice: "zh-CN-YunxiNeural",
  lang: "zh-CN",
  rate: "-8%",
  pitch: "-2Hz",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  timeout: 30000,
});
export const DEFAULT_TTS_CHUNK_CHARS = 40;

export function ensureTtsSentenceTerminator(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("TTS unit must not be empty");
  if (/[。！？!?]$/u.test(text)) return text;
  return `${text.replace(/[，、；：,;:]+$/u, "")}。`;
}

export function buildBodyTtsUnits(displayTitle, rows) {
  const title = String(displayTitle || "").trim().replace(/^《|》$/gu, "");
  if (!title) throw new Error("Display title is required for TTS input");
  return [
    ensureTtsSentenceTerminator(`《${title}》`),
    ...rows.map((row) => ensureTtsSentenceTerminator(row.text)),
  ];
}

export function buildBodyTtsChunks(units, maxChars = DEFAULT_TTS_CHUNK_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error(`Invalid TTS chunk size: ${maxChars}`);
  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const value of units) {
    const unit = String(value || "").trim();
    if (!unit) throw new Error("TTS chunk input must not contain empty units");
    const separatorChars = current.length ? 1 : 0;
    if (current.length && currentChars + separatorChars + unit.length > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(unit);
    currentChars += (current.length > 1 ? 1 : 0) + unit.length;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

export function edgeSubtitleOutputPath(audioPath) {
  return `${audioPath}.json`;
}
