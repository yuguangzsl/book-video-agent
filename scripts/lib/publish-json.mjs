import { readJsonFile } from "./json.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

const PLATFORM_TITLE_LIMITS = {
  douyin: 30,
  xiaohongshu: 20,
};

function validatePlatformCopy(copy, platform, filePath) {
  const field = `${filePath}: copy.platforms.${platform}`;
  assert(isObject(copy), `${field} must be an object`);
  assert(typeof copy.title === "string" && copy.title.trim(), `${field}.title must be a non-empty string`);
  assert(
    [...copy.title].length <= PLATFORM_TITLE_LIMITS[platform],
    `${field}.title must not exceed ${PLATFORM_TITLE_LIMITS[platform]} characters`,
  );
  if (copy.description !== undefined) {
    assert(typeof copy.description === "string" && copy.description.trim(), `${field}.description must be a non-empty string`);
  }
  if (copy.hashtags !== undefined) {
    assert(
      isStringArray(copy.hashtags) && copy.hashtags.length >= 3 && copy.hashtags.length <= 5,
      `${field}.hashtags must contain 3-5 non-empty strings`,
    );
  }
}

function validateResearchAttempt(attempt, index, filePath) {
  const field = `${filePath}: research.attempts[${index}]`;
  assert(isObject(attempt), `${field} must be an object`);
  for (const key of ["source", "method", "status", "reason"]) {
    assert(typeof attempt[key] === "string" && attempt[key].trim(), `${field}.${key} must be a non-empty string`);
  }
  assert(
    typeof attempt.observedAt === "string" && Number.isFinite(Date.parse(attempt.observedAt)),
    `${field}.observedAt must be an ISO date`,
  );
}

function validateVideoSample(sample, index, filePath) {
  const field = `${filePath}: research.videoSamples[${index}]`;
  assert(isObject(sample), `${field} must be an object`);
  const source = sample.source || sample.platform;
  assert(typeof source === "string" && source.trim(), `${field}.source or .platform must be a non-empty string`);
  assert(typeof sample.title === "string" && sample.title.trim(), `${field}.title must be a non-empty string`);
  assert(typeof sample.url === "string" && /^https?:\/\//iu.test(sample.url), `${field}.url must be an http(s) URL`);
  assert(
    typeof sample.publishedAt === "string" && Number.isFinite(Date.parse(sample.publishedAt)),
    `${field}.publishedAt must be an ISO date`,
  );
  assert(
    (typeof sample.description === "string" && sample.description.trim())
    || sample.descriptionStatus === "missing",
    `${field} must contain a description or descriptionStatus=missing`,
  );
  const metrics = sample.visibleMetrics || sample.metrics;
  assert(isObject(metrics) && Object.keys(metrics).length > 0, `${field}.visibleMetrics or .metrics must be a non-empty object`);
}

function validateFallbackSignal(signal, index, filePath) {
  const field = `${filePath}: research.fallbackSignals[${index}]`;
  assert(isObject(signal), `${field} must be an object`);
  assert(typeof signal.source === "string" && signal.source.trim(), `${field}.source must be a non-empty string`);
  assert(typeof signal.signal === "string" && signal.signal.trim(), `${field}.signal must be a non-empty string`);
  assert(signal.value !== undefined && signal.value !== null && String(signal.value).trim(), `${field}.value must be present`);
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
  assert(Array.isArray(data.research.attempts) && data.research.attempts.length > 0, `${filePath}: research.attempts must be a non-empty array`);
  assert(Array.isArray(data.research.videoSamples), `${filePath}: research.videoSamples must be an array`);
  assert(Array.isArray(data.research.fallbackSignals), `${filePath}: research.fallbackSignals must be an array`);
  assert(isStringArray(data.research.patterns), `${filePath}: research.patterns must be a non-empty string array`);
  data.research.attempts.forEach((attempt, index) => validateResearchAttempt(attempt, index, filePath));
  data.research.videoSamples.forEach((sample, index) => validateVideoSample(sample, index, filePath));
  data.research.fallbackSignals.forEach((signal, index) => validateFallbackSignal(signal, index, filePath));
  if (data.research.popularVideoSampleStatus === "unavailable") {
    assert(data.research.fallbackSignals.length >= 5, `${filePath}: unavailable video research requires at least 5 fallback signals`);
  } else {
    assert(data.research.videoSamples.length >= 5, `${filePath}: available video research requires at least 5 video samples`);
  }

  assert(isObject(data.copy), `${filePath}: copy must be an object`);
  assert(isStringArray(data.copy.titleCandidates) && data.copy.titleCandidates.length === 3, `${filePath}: copy.titleCandidates must contain exactly 3 non-empty strings`);
  assert(typeof data.copy.selectedTitle === "string" && data.copy.selectedTitle.trim(), `${filePath}: copy.selectedTitle must be a non-empty string`);
  assert(data.copy.titleCandidates.includes(data.copy.selectedTitle), `${filePath}: copy.selectedTitle must be one of copy.titleCandidates`);
  assert(typeof data.copy.description === "string" && data.copy.description.trim(), `${filePath}: copy.description must be a non-empty string`);
  assert(isStringArray(data.copy.hashtags) && data.copy.hashtags.length >= 3 && data.copy.hashtags.length <= 5, `${filePath}: copy.hashtags must contain 3-5 non-empty strings`);
  assert(typeof data.copy.viralityDisclaimer === "string" && data.copy.viralityDisclaimer.trim(), `${filePath}: copy.viralityDisclaimer must be a non-empty string`);
  if (data.copy.platforms !== undefined) {
    assert(isObject(data.copy.platforms), `${filePath}: copy.platforms must be an object`);
    for (const platform of Object.keys(data.copy.platforms)) {
      assert(PLATFORM_TITLE_LIMITS[platform], `${filePath}: unsupported copy platform ${platform}`);
      validatePlatformCopy(data.copy.platforms[platform], platform, filePath);
    }
  }

  return data;
}

export function readPublishJson(filePath) {
  return validatePublishJsonObject(readJsonFile(filePath), filePath);
}

export function validatePublishJsonAgainstManifest(data, manifest, filePath = "publish.json") {
  validatePublishJsonObject(data, filePath);
  assert(data.book === manifest.episode.name, `${filePath}: book does not match render manifest episode.name`);
  assert(data.inputs.scriptVersion === manifest.episode.scriptVersion, `${filePath}: scriptVersion does not match render manifest`);
  assert(data.inputs.scriptSha256.toLowerCase() === manifest.inputs.script.sha256.toLowerCase(), `${filePath}: scriptSha256 does not match render manifest`);
  assert(data.inputs.renderSha256.toLowerCase() === manifest.output.sha256.toLowerCase(), `${filePath}: renderSha256 does not match render manifest`);
  return data;
}
