export const DEFAULT_TTS_OPTIONS = Object.freeze({
  voice: "zh-CN-YunxiNeural",
  lang: "zh-CN",
  rate: "-8%",
  pitch: "-2Hz",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  timeout: 30000,
});

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

export function edgeSubtitleOutputPath(audioPath) {
  return `${audioPath}.json`;
}
