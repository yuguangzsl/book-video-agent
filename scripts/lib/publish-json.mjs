import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

export function validatePublishJsonObject(data, filePath = "publish.json") {
  assert(isObject(data), `${filePath}: root must be an object`);
  assert(data.schemaVersion === 1, `${filePath}: schemaVersion must be 1`);
  assert(typeof data.book === "string" && data.book.trim(), `${filePath}: book must be a non-empty string`);
  assert(typeof data.generatedAt === "string" && data.generatedAt.trim(), `${filePath}: generatedAt must be a non-empty string`);

  assert(isObject(data.inputs), `${filePath}: inputs must be an object`);
  assert(typeof data.inputs.scriptVersion === "string" && data.inputs.scriptVersion.trim(), `${filePath}: inputs.scriptVersion must be a non-empty string`);
  assert(typeof data.inputs.scriptSha256 === "string" && /^[a-f0-9]{64}$/i.test(data.inputs.scriptSha256), `${filePath}: inputs.scriptSha256 must be a sha256 hex string`);
  assert(typeof data.inputs.renderSha256 === "string" && /^[a-f0-9]{64}$/i.test(data.inputs.renderSha256), `${filePath}: inputs.renderSha256 must be a sha256 hex string`);

  assert(isObject(data.research), `${filePath}: research must be an object`);
  assert(typeof data.research.scope === "string" && data.research.scope.trim(), `${filePath}: research.scope must be a non-empty string`);
  assert(typeof data.research.popularVideoSampleStatus === "string" && data.research.popularVideoSampleStatus.trim(), `${filePath}: research.popularVideoSampleStatus must be a non-empty string`);
  assert(isStringArray(data.research.notes), `${filePath}: research.notes must be a non-empty string array`);
  assert(Array.isArray(data.research.attempts), `${filePath}: research.attempts must be an array`);
  assert(Array.isArray(data.research.videoSamples), `${filePath}: research.videoSamples must be an array`);
  assert(Array.isArray(data.research.fallbackSignals), `${filePath}: research.fallbackSignals must be an array`);
  assert(isStringArray(data.research.patterns), `${filePath}: research.patterns must be a non-empty string array`);

  assert(isObject(data.copy), `${filePath}: copy must be an object`);
  assert(isStringArray(data.copy.titleCandidates) && data.copy.titleCandidates.length === 3, `${filePath}: copy.titleCandidates must contain exactly 3 non-empty strings`);
  assert(typeof data.copy.selectedTitle === "string" && data.copy.selectedTitle.trim(), `${filePath}: copy.selectedTitle must be a non-empty string`);
  assert(typeof data.copy.description === "string" && data.copy.description.trim(), `${filePath}: copy.description must be a non-empty string`);
  assert(isStringArray(data.copy.hashtags) && data.copy.hashtags.length >= 3 && data.copy.hashtags.length <= 5, `${filePath}: copy.hashtags must contain 3-5 non-empty strings`);
  assert(typeof data.copy.viralityDisclaimer === "string" && data.copy.viralityDisclaimer.trim(), `${filePath}: copy.viralityDisclaimer must be a non-empty string`);

  return data;
}

export function readPublishJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  const data = JSON.parse(raw);
  return validatePublishJsonObject(data, filePath);
}

export function validatePublishJsonAgainstManifest(data, manifest, filePath = "publish.json") {
  validatePublishJsonObject(data, filePath);
  assert(data.book === manifest.episode.name, `${filePath}: book does not match render manifest episode.name`);
  assert(data.inputs.scriptVersion === manifest.episode.scriptVersion, `${filePath}: scriptVersion does not match render manifest`);
  assert(data.inputs.scriptSha256.toLowerCase() === manifest.inputs.script.sha256.toLowerCase(), `${filePath}: scriptSha256 does not match render manifest`);
  assert(data.inputs.renderSha256.toLowerCase() === manifest.output.sha256.toLowerCase(), `${filePath}: renderSha256 does not match render manifest`);
  return data;
}
