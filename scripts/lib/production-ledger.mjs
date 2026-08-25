import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./filesystem.mjs";
import { readJsonFile } from "./json.mjs";
import { readReleasePackage } from "./release-package.mjs";
import { readAndValidateRenderManifest } from "./render-manifest.mjs";
import { normalizeDisplayTitle } from "./title-normalization.mjs";

export const PRODUCTION_LEDGER_SCHEMA_VERSION = 1;
export const PRODUCTION_LEDGER_KIND = "book-video-production-ledger";
export const PRODUCTION_LEDGER_PLATFORMS = ["douyin", "xiaohongshu"];

const OFFICIAL_PLATFORM_HOSTS = {
  douyin: new Set(["creator.douyin.com", "www.douyin.com", "douyin.com"]),
  xiaohongshu: new Set(["creator.xiaohongshu.com", "www.xiaohongshu.com", "xiaohongshu.com"]),
};

const PUBLICATION_EVIDENCE_STATES = new Set(["published", "unverified"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/iu.test(String(value || ""));
}

function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isoNow(value) {
  if (value instanceof Date) return value.toISOString();
  if (value !== undefined && value !== null) {
    const text = String(value);
    assert(isIsoDate(text), `Expected an ISO date, got ${text}`);
    return text;
  }
  return new Date().toISOString();
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function titleKey(value) {
  return normalizeDisplayTitle(value)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-CN");
}

function authorKey(value) {
  return normalizedText(value).toLocaleLowerCase("zh-CN");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(prefix, value) {
  return `${prefix}:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function appendUnique(items, value, identity = (candidate) => candidate?.id || stableJson(candidate)) {
  const key = identity(value);
  if (!items.some((candidate) => identity(candidate) === key)) items.push(value);
  return items;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right), "zh-CN"));
}

function projectPortablePath(root, targetPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  if (!relative) return ".";
  return resolvedTarget;
}

function resolveProjectMaybePortablePath(root, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text);
}

function safeJsonFile(filePath, warnings, label) {
  try {
    return readJsonFile(filePath);
  } catch (error) {
    warnings.push(`${label || filePath}: ${error.message}`);
    return null;
  }
}

function ledgerPathFor(root) {
  return path.join(root, ".agents", "production-ledger.json");
}

function ledgerLockPathFor(root) {
  return path.join(root, ".agents", "production-ledger.lock");
}

export function productionLedgerPath(root) {
  return ledgerPathFor(root);
}

export function normalizeProductionIdentity(displayTitle, author = "") {
  const normalizedTitle = normalizeDisplayTitle(displayTitle);
  const normalizedAuthor = normalizedText(author);
  return {
    displayTitle: normalizedTitle,
    author: normalizedAuthor,
    titleKey: titleKey(normalizedTitle),
    authorKey: authorKey(normalizedAuthor),
    authorKnown: Boolean(normalizedAuthor),
  };
}

export function createProductionWorkId(displayTitle, author = "") {
  const identity = normalizeProductionIdentity(displayTitle, author);
  const authorSegment = identity.authorKnown
    ? `known:${encodeURIComponent(identity.authorKey)}`
    : "missing";
  return `work:title=${encodeURIComponent(identity.titleKey)};author=${authorSegment}`;
}

function createPlatformLedger() {
  return {
    publicationState: "unverified",
    queueStates: [],
    attempts: [],
    proofs: [],
    retractedProofs: [],
  };
}

function createReleasePlatforms() {
  return Object.fromEntries(PRODUCTION_LEDGER_PLATFORMS.map((platform) => [platform, createPlatformLedger()]));
}

export function createProductionLedger(options = {}) {
  const now = isoNow(options.now);
  return {
    schemaVersion: PRODUCTION_LEDGER_SCHEMA_VERSION,
    kind: PRODUCTION_LEDGER_KIND,
    createdAt: now,
    updatedAt: now,
    works: {},
    renders: {},
    releases: {},
    unresolvedReferences: [],
  };
}

function ensureArray(value, field) {
  assert(Array.isArray(value), `${field} must be an array`);
}

function validateSourceRecords(records, field) {
  ensureArray(records, field);
  for (const record of records) {
    assert(isObject(record), `${field} entries must be objects`);
    assert(typeof record.id === "string" && record.id, `${field} entry id is required`);
  }
}

function validatePlatformLedger(platform, value, field) {
  assert(isObject(value), `${field} must be an object`);
  assert(PUBLICATION_EVIDENCE_STATES.has(value.publicationState), `${field}.publicationState is invalid`);
  validateSourceRecords(value.queueStates, `${field}.queueStates`);
  validateSourceRecords(value.attempts, `${field}.attempts`);
  validateSourceRecords(value.proofs, `${field}.proofs`);
  validateSourceRecords(value.retractedProofs, `${field}.retractedProofs`);
  for (const proof of value.proofs) {
    assert(proof.platform === platform, `${field}.proofs platform mismatch`);
    assert(isIsoDate(proof.verifiedAt), `${field}.proofs verifiedAt must be an ISO date`);
    assert(typeof proof.signal === "string" && proof.signal.trim(), `${field}.proofs signal is required`);
    assert(typeof proof.url === "string" && proof.url.trim(), `${field}.proofs url is required`);
    assert(proof.trusted === true, `${field}.proofs must be trusted evidence`);
  }
}

export function validateProductionLedger(ledger, filePath = "production-ledger.json") {
  assert(isObject(ledger), `${filePath}: root must be an object`);
  assert(ledger.schemaVersion === PRODUCTION_LEDGER_SCHEMA_VERSION, `${filePath}: unsupported schemaVersion`);
  assert(ledger.kind === PRODUCTION_LEDGER_KIND, `${filePath}: kind is invalid`);
  assert(isIsoDate(ledger.createdAt), `${filePath}: createdAt must be an ISO date`);
  assert(isIsoDate(ledger.updatedAt), `${filePath}: updatedAt must be an ISO date`);
  assert(isObject(ledger.works), `${filePath}: works must be an object`);
  assert(isObject(ledger.renders), `${filePath}: renders must be an object`);
  assert(isObject(ledger.releases), `${filePath}: releases must be an object`);
  ensureArray(ledger.unresolvedReferences, `${filePath}: unresolvedReferences`);

  for (const [workId, work] of Object.entries(ledger.works)) {
    assert(isObject(work), `${filePath}: work ${workId} must be an object`);
    assert(work.workId === workId, `${filePath}: work ${workId} key mismatch`);
    assert(typeof work.displayTitle === "string" && work.displayTitle.trim(), `${filePath}: work ${workId} title is required`);
    assert(typeof work.author === "string", `${filePath}: work ${workId} author must be a string`);
    assert(work.titleKey === titleKey(work.displayTitle), `${filePath}: work ${workId} titleKey mismatch`);
    assert(work.authorKey === authorKey(work.author), `${filePath}: work ${workId} authorKey mismatch`);
    assert(work.authorKnown === Boolean(work.author), `${filePath}: work ${workId} authorKnown mismatch`);
    assert(workId === createProductionWorkId(work.displayTitle, work.author), `${filePath}: work ${workId} identity mismatch`);
    assert(isIsoDate(work.createdAt), `${filePath}: work ${workId} createdAt must be an ISO date`);
    assert(isIsoDate(work.updatedAt), `${filePath}: work ${workId} updatedAt must be an ISO date`);
    ensureArray(work.renderSha256s, `${filePath}: work ${workId} renderSha256s`);
    ensureArray(work.releaseIds, `${filePath}: work ${workId} releaseIds`);
    ensureArray(work.generatedIndexClaims, `${filePath}: work ${workId} generatedIndexClaims`);
    for (const hash of work.renderSha256s) assert(isSha256(hash), `${filePath}: work ${workId} has invalid render hash`);
    for (const releaseId of work.releaseIds) assert(isSha256(releaseId), `${filePath}: work ${workId} has invalid release id`);
  }

  for (const [renderSha256, render] of Object.entries(ledger.renders)) {
    assert(isSha256(renderSha256), `${filePath}: render key is invalid`);
    assert(isObject(render), `${filePath}: render ${renderSha256} must be an object`);
    assert(render.renderSha256 === renderSha256.toLowerCase(), `${filePath}: render ${renderSha256} key mismatch`);
    assert(ledger.works[render.workId], `${filePath}: render ${renderSha256} references missing work`);
    assert(typeof render.episodeName === "string" && render.episodeName.trim(), `${filePath}: render ${renderSha256} episodeName is required`);
    assert(typeof render.scriptVersion === "string" && render.scriptVersion.trim(), `${filePath}: render ${renderSha256} scriptVersion is required`);
    assert(isIsoDate(render.firstValidatedAt), `${filePath}: render ${renderSha256} firstValidatedAt must be an ISO date`);
    assert(isIsoDate(render.lastValidatedAt), `${filePath}: render ${renderSha256} lastValidatedAt must be an ISO date`);
    validateSourceRecords(render.sources, `${filePath}: render ${renderSha256} sources`);
    ensureArray(render.validations, `${filePath}: render ${renderSha256} validations`);
  }

  for (const [releaseId, release] of Object.entries(ledger.releases)) {
    assert(isSha256(releaseId), `${filePath}: release key is invalid`);
    assert(isObject(release), `${filePath}: release ${releaseId} must be an object`);
    assert(release.releaseId === releaseId.toLowerCase(), `${filePath}: release ${releaseId} key mismatch`);
    assert(ledger.works[release.workId], `${filePath}: release ${releaseId} references missing work`);
    assert(isSha256(release.renderSha256), `${filePath}: release ${releaseId} render hash is invalid`);
    assert(ledger.renders[release.renderSha256], `${filePath}: release ${releaseId} references missing render`);
    assert(typeof release.episodeName === "string" && release.episodeName.trim(), `${filePath}: release ${releaseId} episodeName is required`);
    assert(typeof release.scriptVersion === "string" && release.scriptVersion.trim(), `${filePath}: release ${releaseId} scriptVersion is required`);
    assert(typeof release.manifestPath === "string" && release.manifestPath.trim(), `${filePath}: release ${releaseId} manifestPath is required`);
    assert(isIsoDate(release.createdAt), `${filePath}: release ${releaseId} createdAt must be an ISO date`);
    validateSourceRecords(release.sources, `${filePath}: release ${releaseId} sources`);
    validateSourceRecords(release.queueSnapshots, `${filePath}: release ${releaseId} queueSnapshots`);
    assert(isObject(release.platforms), `${filePath}: release ${releaseId} platforms must be an object`);
    for (const platform of PRODUCTION_LEDGER_PLATFORMS) {
      validatePlatformLedger(platform, release.platforms[platform], `${filePath}: release ${releaseId} ${platform}`);
    }
  }

  for (const unresolved of ledger.unresolvedReferences) {
    assert(isObject(unresolved), `${filePath}: unresolved reference must be an object`);
    assert(typeof unresolved.id === "string" && unresolved.id, `${filePath}: unresolved reference id is required`);
    assert(typeof unresolved.reason === "string" && unresolved.reason, `${filePath}: unresolved reference reason is required`);
  }
  return ledger;
}

function normalizeLedgerLinks(ledger) {
  for (const work of Object.values(ledger.works)) {
    work.renderSha256s = [];
    work.releaseIds = [];
  }
  for (const render of Object.values(ledger.renders)) {
    const work = ledger.works[render.workId];
    if (work) work.renderSha256s.push(render.renderSha256);
  }
  for (const release of Object.values(ledger.releases)) {
    const work = ledger.works[release.workId];
    if (work) work.releaseIds.push(release.releaseId);
  }
  for (const work of Object.values(ledger.works)) {
    work.renderSha256s = sortedUnique(work.renderSha256s);
    work.releaseIds = sortedUnique(work.releaseIds);
  }
}

function activeProofs(platformLedger) {
  return platformLedger.proofs.filter((proof) => !proof.retractedAt);
}

export function refreshProductionLedgerPublicationStates(ledger) {
  for (const release of Object.values(ledger.releases)) {
    for (const platform of PRODUCTION_LEDGER_PLATFORMS) {
      const record = release.platforms[platform];
      for (const retracted of record.retractedProofs) {
        for (const proof of record.proofs) {
          if (matchingProof(proof, retracted)) {
            proof.retractedAt = retracted.retractedAt;
            proof.retractionReason = retracted.retractionReason;
          }
        }
      }
      record.publicationState = activeProofs(record).length > 0 ? "published" : "unverified";
    }
  }
  normalizeLedgerLinks(ledger);
  return ledger;
}

function createWorkRecord(identity, now) {
  return {
    workId: createProductionWorkId(identity.displayTitle, identity.author),
    ...identity,
    createdAt: now,
    updatedAt: now,
    renderSha256s: [],
    releaseIds: [],
    generatedIndexClaims: [],
  };
}

export function ensureProductionWork(ledger, identityInput, options = {}) {
  const now = isoNow(options.now);
  const identity = normalizeProductionIdentity(identityInput?.displayTitle || identityInput?.title || "", identityInput?.author || "");
  const workId = createProductionWorkId(identity.displayTitle, identity.author);
  const existing = ledger.works[workId];
  if (existing) {
    existing.updatedAt = now;
    return existing;
  }
  const work = createWorkRecord(identity, now);
  ledger.works[workId] = work;
  return work;
}

function normalizedSource(source, fallbackId) {
  const record = isObject(source) ? structuredClone(source) : {};
  if (!record.id) record.id = fallbackId || fingerprint("source", record);
  return record;
}

export function recordValidatedRender(ledger, input, options = {}) {
  assert(isObject(input), "Validated render input is required");
  const renderSha256 = String(input.renderSha256 || input.sha256 || "").toLowerCase();
  assert(isSha256(renderSha256), "Validated render requires a sha256 hash");
  const now = isoNow(options.now || input.validatedAt);
  const work = ensureProductionWork(ledger, {
    displayTitle: input.displayTitle || input.episodeName || input.book,
    author: input.author,
  }, { now });
  const existing = ledger.renders[renderSha256];
  if (existing) {
    assert(existing.workId === work.workId, `Render ${renderSha256} cannot belong to multiple works`);
    existing.lastValidatedAt = now;
    if (input.episodeName) existing.episodeName = String(input.episodeName);
    if (input.scriptVersion) existing.scriptVersion = String(input.scriptVersion);
    if (input.videoPath) existing.videoPath = String(input.videoPath);
    if (input.manifestPath) existing.manifestPath = String(input.manifestPath);
    if (Number.isInteger(input.bytes) && input.bytes >= 0) existing.bytes = input.bytes;
    if (input.validation) appendUnique(existing.validations, String(input.validation), (value) => value);
    if (input.source) appendUnique(existing.sources, normalizedSource(input.source), (value) => value.id);
    return existing;
  }
  const record = {
    renderSha256,
    workId: work.workId,
    episodeName: String(input.episodeName || input.book || work.displayTitle).trim(),
    scriptVersion: String(input.scriptVersion || "unknown").trim() || "unknown",
    ...(input.videoPath ? { videoPath: String(input.videoPath) } : {}),
    ...(input.manifestPath ? { manifestPath: String(input.manifestPath) } : {}),
    ...(Number.isInteger(input.bytes) && input.bytes >= 0 ? { bytes: input.bytes } : {}),
    firstValidatedAt: now,
    lastValidatedAt: now,
    validations: input.validation ? [String(input.validation)] : [],
    sources: input.source ? [normalizedSource(input.source)] : [],
  };
  ledger.renders[renderSha256] = record;
  normalizeLedgerLinks(ledger);
  return record;
}

export function recordProductionRelease(ledger, input, options = {}) {
  assert(isObject(input), "Production release input is required");
  const releaseId = String(input.releaseId || "").toLowerCase();
  assert(isSha256(releaseId), "Production release requires a releaseId");
  const renderSha256 = String(input.renderSha256 || input.sha256 || "").toLowerCase();
  assert(isSha256(renderSha256), `Production release ${releaseId} requires a render hash`);
  const now = isoNow(options.now || input.createdAt);
  const work = ensureProductionWork(ledger, {
    displayTitle: input.displayTitle || input.episodeName || input.book,
    author: input.author,
  }, { now });
  recordValidatedRender(ledger, {
    renderSha256,
    displayTitle: work.displayTitle,
    author: work.author,
    episodeName: input.episodeName || input.book || work.displayTitle,
    scriptVersion: input.scriptVersion || "unknown",
    videoPath: input.videoPath,
    manifestPath: input.renderManifestPath,
    bytes: input.bytes,
    validation: input.renderValidation || "release-package",
    source: input.renderSource || input.source,
  }, { now });

  const existing = ledger.releases[releaseId];
  if (existing) {
    assert(existing.workId === work.workId, `Release ${releaseId} cannot belong to multiple works`);
    assert(existing.renderSha256 === renderSha256, `Release ${releaseId} render hash changed`);
    if (input.manifestPath) existing.manifestPath = String(input.manifestPath);
    if (input.readyPath) existing.readyPath = String(input.readyPath);
    if (input.videoPath) existing.videoPath = String(input.videoPath);
    if (input.source) appendUnique(existing.sources, normalizedSource(input.source), (value) => value.id);
    normalizeLedgerLinks(ledger);
    return existing;
  }
  const release = {
    releaseId,
    workId: work.workId,
    renderSha256,
    episodeName: String(input.episodeName || input.book || work.displayTitle).trim(),
    scriptVersion: String(input.scriptVersion || "unknown").trim() || "unknown",
    manifestPath: String(input.manifestPath || "unknown").trim() || "unknown",
    ...(input.readyPath ? { readyPath: String(input.readyPath) } : {}),
    ...(input.videoPath ? { videoPath: String(input.videoPath) } : {}),
    createdAt: isoNow(input.createdAt || now),
    sources: input.source ? [normalizedSource(input.source)] : [],
    queueSnapshots: [],
    platforms: createReleasePlatforms(),
  };
  ledger.releases[releaseId] = release;
  normalizeLedgerLinks(ledger);
  return release;
}

function recordUnresolvedReference(ledger, details) {
  const value = {
    ...details,
    id: details.id || fingerprint("unresolved", details),
    reason: String(details.reason || "unresolved reference"),
  };
  appendUnique(ledger.unresolvedReferences, value, (item) => item.id);
  return value;
}

function normalizeTrustedProof(platform, release, proof, source) {
  assert(PRODUCTION_LEDGER_PLATFORMS.includes(platform), `Unsupported platform: ${platform}`);
  assert(isObject(proof), `${platform} proof must be an object`);
  const url = String(proof.url || "").trim();
  const signal = String(proof.signal || "").trim();
  const verifiedAt = String(proof.verifiedAt || "").trim();
  assert(url && signal && isIsoDate(verifiedAt), `${platform} proof requires verifiedAt, signal, and url`);
  const parsed = new URL(url);
  assert(parsed.protocol === "https:", `${platform} proof URL must use https`);
  assert(OFFICIAL_PLATFORM_HOSTS[platform].has(parsed.hostname), `${platform} proof URL must use an official host`);
  if (proof.platform !== undefined) assert(proof.platform === platform, `${platform} proof platform mismatch`);
  if (proof.releaseId !== undefined) assert(String(proof.releaseId).toLowerCase() === release.releaseId, `${platform} proof releaseId mismatch`);
  if (proof.renderSha256 !== undefined) {
    assert(String(proof.renderSha256).toLowerCase() === release.renderSha256, `${platform} proof render hash mismatch`);
  }
  const normalized = {
    platform,
    releaseId: release.releaseId,
    renderSha256: release.renderSha256,
    verifiedAt,
    signal,
    url: parsed.toString(),
    ...(String(proof.workId || "").trim() ? { workId: String(proof.workId).trim() } : {}),
    ...(String(proof.screenshotPath || "").trim() ? { screenshotPath: String(proof.screenshotPath).trim() } : {}),
    ...(String(proof.sessionId || "").trim() ? { sessionId: String(proof.sessionId).trim() } : {}),
    ...(String(proof.confirmedAt || "").trim() ? { confirmedAt: String(proof.confirmedAt).trim() } : {}),
    ...(String(proof.listedAt || "").trim() ? { listedAt: String(proof.listedAt).trim() } : {}),
    ...(String(proof.statusSignal || "").trim() ? { statusSignal: String(proof.statusSignal).trim() } : {}),
    ...(String(proof.acceptedSignal || "").trim() ? { acceptedSignal: String(proof.acceptedSignal).trim() } : {}),
    ...(String(proof.successUrl || "").trim() ? { successUrl: String(proof.successUrl).trim() } : {}),
    ...(isObject(proof.account) ? { account: structuredClone(proof.account) } : {}),
    trusted: true,
    source: String(source || "queue"),
  };
  normalized.id = fingerprint("proof", {
    platform: normalized.platform,
    releaseId: normalized.releaseId,
    renderSha256: normalized.renderSha256,
    verifiedAt: normalized.verifiedAt,
    signal: normalized.signal,
    url: normalized.url,
    workId: normalized.workId || "",
  });
  return normalized;
}

function matchingProof(proof, candidate) {
  return proof.id === candidate.id
    || (
      proof.releaseId === candidate.releaseId
      && proof.renderSha256 === candidate.renderSha256
      && proof.url === candidate.url
      && proof.signal === candidate.signal
      && proof.verifiedAt === candidate.verifiedAt
    );
}

export function recordPlatformPublicationProof(ledger, input) {
  assert(isObject(input), "Publication proof input is required");
  const releaseId = String(input.releaseId || "").toLowerCase();
  const platform = String(input.platform || "").trim();
  const release = ledger.releases[releaseId];
  assert(release, `Cannot record publication proof for unknown release ${releaseId}`);
  const proof = normalizeTrustedProof(platform, release, input.proof, input.source);
  const platformLedger = release.platforms[platform];
  const priorRetraction = platformLedger.retractedProofs.find((candidate) => matchingProof(candidate, proof));
  if (priorRetraction) {
    proof.retractedAt = priorRetraction.retractedAt;
    proof.retractionReason = priorRetraction.retractionReason;
  }
  appendUnique(platformLedger.proofs, proof, (candidate) => candidate.id);
  refreshProductionLedgerPublicationStates(ledger);
  return proof;
}

export function recordRetractedPublicationProof(ledger, input) {
  assert(isObject(input), "Retracted publication proof input is required");
  const releaseId = String(input.releaseId || "").toLowerCase();
  const platform = String(input.platform || "").trim();
  const release = ledger.releases[releaseId];
  assert(release, `Cannot record a retracted proof for unknown release ${releaseId}`);
  const proof = normalizeTrustedProof(platform, release, input.proof, input.source || "queue-retraction");
  const retractedAt = isoNow(input.retractedAt);
  const retractionReason = String(input.reason || "publication proof retracted").trim();
  const retracted = {
    ...proof,
    id: fingerprint("retracted-proof", { proofId: proof.id, retractedAt, retractionReason }),
    retractedAt,
    retractionReason,
  };
  const platformLedger = release.platforms[platform];
  for (const active of platformLedger.proofs) {
    if (matchingProof(active, proof)) {
      active.retractedAt = retractedAt;
      active.retractionReason = retractionReason;
    }
  }
  appendUnique(platformLedger.retractedProofs, retracted, (candidate) => candidate.id);
  refreshProductionLedgerPublicationStates(ledger);
  return retracted;
}

export function recordPlatformPublicationAttempt(ledger, input) {
  assert(isObject(input), "Publication attempt input is required");
  const releaseId = String(input.releaseId || "").toLowerCase();
  const platform = String(input.platform || "").trim();
  assert(PRODUCTION_LEDGER_PLATFORMS.includes(platform), `Unsupported platform: ${platform}`);
  const release = ledger.releases[releaseId];
  assert(release, `Cannot record publication attempt for unknown release ${releaseId}`);
  const source = String(input.source || "session").trim() || "session";
  const sessionId = String(input.sessionId || "").trim();
  const attempt = {
    id: input.id || fingerprint("attempt", {
      releaseId,
      platform,
      source,
      sessionId,
      status: String(input.status || "unknown"),
      startedAt: String(input.startedAt || input.createdAt || ""),
      updatedAt: String(input.updatedAt || ""),
    }),
    platform,
    releaseId,
    renderSha256: release.renderSha256,
    source,
    ...(sessionId ? { sessionId } : {}),
    ...(Number.isInteger(input.attemptNumber) ? { attemptNumber: input.attemptNumber } : {}),
    status: String(input.status || "unknown"),
    startedAt: isoNow(input.startedAt || input.createdAt || input.updatedAt),
    updatedAt: isoNow(input.updatedAt || input.startedAt || input.createdAt),
    ...(Number.isInteger(input.queuePosition) && input.queuePosition > 0 ? { queuePosition: input.queuePosition } : {}),
    ...(input.account && isObject(input.account) ? { account: structuredClone(input.account) } : {}),
    ...(input.confirmation && isObject(input.confirmation) ? { confirmation: structuredClone(input.confirmation) } : {}),
    ...(input.sessionEvidence && isObject(input.sessionEvidence)
      ? { sessionEvidence: structuredClone(input.sessionEvidence), evidenceTrust: "unverified-session" }
      : {}),
    ...(input.sourcePath ? { sourcePath: String(input.sourcePath) } : {}),
  };
  appendUnique(release.platforms[platform].attempts, attempt, (candidate) => candidate.id);
  // A browser/manual session can report "published", but it is never trusted publication evidence by itself.
  refreshProductionLedgerPublicationStates(ledger);
  return attempt;
}

export function recordQueueReleaseSnapshot(ledger, input) {
  assert(isObject(input), "Queue snapshot input is required");
  const releaseId = String(input.releaseId || "").toLowerCase();
  const release = ledger.releases[releaseId];
  if (!release) {
    return recordUnresolvedReference(ledger, {
      reason: `Queue snapshot references an unknown or invalid release ${releaseId || "(missing)"}`,
      source: input.source || "queue",
      sourcePath: input.sourcePath || "",
      releaseId,
      item: input.item ? structuredClone(input.item) : undefined,
    });
  }
  const item = input.item || {};
  const observedAt = isoNow(input.observedAt || item.createdAt || input.archivedAt || new Date());
  const renderSha256 = String(item.renderSha256 || input.renderSha256 || "").toLowerCase();
  if (renderSha256 && renderSha256 !== release.renderSha256) {
    return recordUnresolvedReference(ledger, {
      reason: `Queue snapshot render hash does not match release ${releaseId}`,
      source: input.source || "queue",
      sourcePath: input.sourcePath || "",
      releaseId,
      renderSha256,
    });
  }
  const source = String(input.source || "queue");
  const snapshot = {
    id: input.id || fingerprint("queue-snapshot", {
      releaseId,
      source,
      sourcePath: input.sourcePath || "",
      parentReleaseId: input.parentReleaseId || "",
      position: item.position || input.position || null,
      archivedAt: input.archivedAt || "",
      observedAt,
      statuses: Object.fromEntries(PRODUCTION_LEDGER_PLATFORMS.map((platform) => [platform, item[`${platform}Status`] || null])),
    }),
    source,
    ...(input.sourcePath ? { sourcePath: String(input.sourcePath) } : {}),
    ...(input.parentReleaseId ? { parentReleaseId: String(input.parentReleaseId).toLowerCase() } : {}),
    ...(Number.isInteger(Number(item.position || input.position)) ? { position: Number(item.position || input.position) } : {}),
    ...(input.archivedAt ? { archivedAt: isoNow(input.archivedAt) } : {}),
    observedAt,
    statuses: Object.fromEntries(PRODUCTION_LEDGER_PLATFORMS.map((platform) => [platform, item[`${platform}Status`] || null])),
  };
  appendUnique(release.queueSnapshots, snapshot, (candidate) => candidate.id);
  for (const platform of PRODUCTION_LEDGER_PLATFORMS) {
    const queueState = {
      id: `${snapshot.id}:${platform}`,
      sourceSnapshotId: snapshot.id,
      source,
      status: snapshot.statuses[platform],
      observedAt,
      ...(snapshot.position ? { position: snapshot.position } : {}),
    };
    appendUnique(release.platforms[platform].queueStates, queueState, (candidate) => candidate.id);
    const proof = item[`${platform}Publication`];
    if (proof) {
      try {
        recordPlatformPublicationProof(ledger, { releaseId, platform, proof, source });
      } catch (error) {
        recordUnresolvedReference(ledger, {
          reason: `Untrusted ${platform} queue proof for release ${releaseId}: ${error.message}`,
          source,
          sourcePath: input.sourcePath || "",
          releaseId,
        });
      }
    }
    for (const retraction of item[`${platform}PublicationRetractions`] || []) {
      if (!isObject(retraction?.publication)) continue;
      try {
        recordRetractedPublicationProof(ledger, {
          releaseId,
          platform,
          proof: retraction.publication,
          retractedAt: retraction.retractedAt,
          reason: retraction.reason,
          source: `${source}-retraction`,
        });
      } catch (error) {
        recordUnresolvedReference(ledger, {
          reason: `Invalid ${platform} proof retraction for release ${releaseId}: ${error.message}`,
          source,
          sourcePath: input.sourcePath || "",
          releaseId,
        });
      }
    }
  }
  refreshProductionLedgerPublicationStates(ledger);
  return snapshot;
}

export function recordGeneratedIndexClaim(ledger, input, options = {}) {
  assert(isObject(input), "Generated-index claim input is required");
  const now = isoNow(options.now || input.recordedAt);
  const identity = normalizeProductionIdentity(input.displayTitle || input.title, input.author || "");
  // The legacy title index has no author. It may join a known work only when the
  // normalized title identifies exactly one work; otherwise retain a distinct
  // missing-author work so same-title books cannot be silently conflated.
  const titleMatches = identity.authorKnown
    ? []
    : Object.values(ledger.works).filter((candidate) => candidate.titleKey === identity.titleKey);
  const work = titleMatches.length === 1
    ? titleMatches[0]
    : ensureProductionWork(ledger, identity, { now });
  const claim = {
    id: input.id || fingerprint("generated-index-claim", {
      workId: work.workId,
      sourcePath: input.sourcePath || "data/generated-book-titles.txt",
      title: work.displayTitle,
    }),
    sourcePath: String(input.sourcePath || "data/generated-book-titles.txt"),
    title: work.displayTitle,
    recordedAt: now,
    evidenceTrust: "legacy-index-claim",
  };
  appendUnique(work.generatedIndexClaims, claim, (candidate) => candidate.id);
  return claim;
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function withLedgerWriteLock(root, operation) {
  const lockPath = ledgerLockPathFor(root);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = safeJsonFile(lockPath, [], lockPath);
    if (!existing || !processIsRunning(Number(existing.pid))) {
      fs.rmSync(lockPath, { force: true });
      handle = fs.openSync(lockPath, "wx");
    } else {
      throw new Error(`Production ledger update is already in progress: ${lockPath}`, { cause: error });
    }
  }
  try {
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    return operation();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

export function readProductionLedger(root, options = {}) {
  const filePath = ledgerPathFor(root);
  if (!fs.existsSync(filePath)) {
    if (options.required) throw new Error(`Missing production ledger: ${filePath}`);
    return null;
  }
  return validateProductionLedger(readJsonFile(filePath), filePath);
}

function writeProductionLedgerUnlocked(root, ledger, options = {}) {
  const next = structuredClone(ledger);
  next.updatedAt = isoNow(options.now);
  refreshProductionLedgerPublicationStates(next);
  validateProductionLedger(next, ledgerPathFor(root));
  writeFileAtomically(ledgerPathFor(root), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
  return readProductionLedger(root, { required: true });
}

export function writeProductionLedger(root, ledger, options = {}) {
  return withLedgerWriteLock(root, () => writeProductionLedgerUnlocked(root, ledger, options));
}

export function updateProductionLedger(root, updater, options = {}) {
  assert(typeof updater === "function", "Production ledger updater must be a function");
  return withLedgerWriteLock(root, () => {
    const current = readProductionLedger(root) || createProductionLedger({ now: options.now });
    const next = updater(structuredClone(current));
    assert(next && typeof next === "object", "Production ledger updater must return a ledger object");
    return writeProductionLedgerUnlocked(root, next, options);
  });
}

function readEpisodeIdentity(root, episodeName, warnings) {
  const fallback = normalizeProductionIdentity(episodeName, "");
  const briefPath = path.join(root, "episodes", episodeName, "brief.json");
  if (!fs.existsSync(briefPath)) return fallback;
  const brief = safeJsonFile(briefPath, warnings, `Brief identity ${briefPath}`);
  if (!isObject(brief)) return fallback;
  return normalizeProductionIdentity(brief.display_title || episodeName, brief.author || "");
}

function scanReleaseManifestPaths(root) {
  const result = [];
  const episodesRoot = path.join(root, "episodes");
  if (!fs.existsSync(episodesRoot)) return result;
  for (const episode of fs.readdirSync(episodesRoot, { withFileTypes: true })) {
    if (!episode.isDirectory()) continue;
    const releasesRoot = path.join(episodesRoot, episode.name, "releases");
    if (!fs.existsSync(releasesRoot)) continue;
    for (const release of fs.readdirSync(releasesRoot, { withFileTypes: true })) {
      if (!release.isDirectory()) continue;
      const manifestPath = path.join(releasesRoot, release.name, "release.json");
      if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) result.push(manifestPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function scanRenderManifestPaths(root) {
  const result = [];
  const episodesRoot = path.join(root, "episodes");
  if (!fs.existsSync(episodesRoot)) return result;
  for (const episode of fs.readdirSync(episodesRoot, { withFileTypes: true })) {
    if (!episode.isDirectory()) continue;
    const rendersRoot = path.join(episodesRoot, episode.name, "renders");
    if (!fs.existsSync(rendersRoot)) continue;
    for (const entry of fs.readdirSync(rendersRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".manifest.json")) result.push(path.join(rendersRoot, entry.name));
    }
  }
  return result.sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function resultVideoPath(root, releaseResult, release) {
  if (releaseResult?.videoPath) return path.resolve(releaseResult.videoPath);
  return resolveProjectMaybePortablePath(root, release?.video?.file);
}

function recordReleasePackageIntoLedger(ledger, root, manifestPath, releaseResult, warnings, options) {
  const release = releaseResult?.release;
  assert(isObject(release), `${manifestPath}: release reader returned no release object`);
  const identity = readEpisodeIdentity(root, release.episode?.name || "", warnings);
  const releasePortablePath = projectPortablePath(root, manifestPath);
  const videoPath = resultVideoPath(root, releaseResult, release);
  return recordProductionRelease(ledger, {
    releaseId: release.releaseId,
    renderSha256: release.video?.sha256,
    displayTitle: identity.displayTitle,
    author: identity.author,
    episodeName: release.episode?.name,
    scriptVersion: release.episode?.scriptVersion,
    manifestPath: releasePortablePath,
    readyPath: projectPortablePath(root, path.join(path.dirname(manifestPath), "READY")),
    videoPath,
    bytes: release.video?.bytes,
    renderManifestPath: release.provenance?.renderManifest?.file,
    createdAt: release.createdAt,
    source: {
      id: `release-package:${release.releaseId}`,
      kind: "valid-release-package",
      manifestPath: releasePortablePath,
    },
    renderSource: {
      id: `release-video:${release.releaseId}`,
      kind: "valid-release-video",
      manifestPath: releasePortablePath,
    },
  }, { now: options.now || release.createdAt });
}

function recordRenderManifestIntoLedger(ledger, root, manifestPath, renderResult, warnings, options) {
  const manifest = renderResult?.manifest;
  assert(isObject(manifest), `${manifestPath}: render reader returned no manifest object`);
  const identity = readEpisodeIdentity(root, manifest.episode?.name || "", warnings);
  const outputPath = resolveProjectMaybePortablePath(root, manifest.output?.file);
  return recordValidatedRender(ledger, {
    renderSha256: manifest.output?.sha256,
    displayTitle: identity.displayTitle,
    author: identity.author,
    episodeName: manifest.episode?.name,
    scriptVersion: manifest.episode?.scriptVersion,
    videoPath: outputPath,
    manifestPath: projectPortablePath(root, manifestPath),
    bytes: manifest.output?.bytes,
    validation: "validated-render-manifest",
    source: {
      id: `render-manifest:${projectPortablePath(root, manifestPath)}`,
      kind: "validated-render-manifest",
      manifestPath: projectPortablePath(root, manifestPath),
    },
  }, { now: options.now || manifest.createdAt });
}

function queueItemsFromFile(root, filePath, kind, warnings) {
  if (!fs.existsSync(filePath)) return [];
  const data = safeJsonFile(filePath, warnings, `${kind} queue ${filePath}`);
  if (!isObject(data) || !Array.isArray(data.items)) {
    warnings.push(`${kind} queue ${filePath}: expected an items array`);
    return [];
  }
  if (kind === "archive") {
    return data.items
      .filter((entry) => isObject(entry?.item))
      .map((entry, index) => ({
        item: entry.item,
        source: "queue-archive",
        sourcePath: projectPortablePath(root, filePath),
        archivedAt: entry.archivedAt,
        id: `queue-archive:${index}`,
      }));
  }
  return data.items
    .filter((item) => isObject(item))
    .map((item, index) => ({
      item,
      source: "queue-active",
      sourcePath: projectPortablePath(root, filePath),
      id: `queue-active:${index}`,
    }));
}

function recordQueueItemAndPreviousReleases(ledger, descriptor, warnings, options, parentReleaseId = "") {
  const item = descriptor.item;
  const releaseId = String(item.releaseId || "").toLowerCase();
  if (!releaseId) {
    recordUnresolvedReference(ledger, {
      id: `${descriptor.id}:missing-release`,
      reason: "Queue entry has no immutable releaseId",
      source: descriptor.source,
      sourcePath: descriptor.sourcePath,
      item: { book: item.book, position: item.position },
    });
  } else {
    recordQueueReleaseSnapshot(ledger, {
      id: descriptor.id,
      releaseId,
      source: descriptor.source,
      sourcePath: descriptor.sourcePath,
      archivedAt: descriptor.archivedAt,
      observedAt: item.createdAt || descriptor.archivedAt || options.now,
      parentReleaseId,
      item,
    });
  }
  for (const [index, previous] of (item.previousReleases || []).entries()) {
    if (!isObject(previous)) {
      warnings.push(`${descriptor.sourcePath}: previousReleases[${index}] is not an object`);
      continue;
    }
    recordQueueItemAndPreviousReleases(ledger, {
      item: previous,
      source: "queue-previous-release",
      sourcePath: descriptor.sourcePath,
      archivedAt: descriptor.archivedAt,
      id: `${descriptor.id}:previous:${index}`,
    }, warnings, options, releaseId);
  }
}

function scanBrowserSessions(root, ledger, warnings, options) {
  const sessionsRoot = path.join(root, ".agents", "browser-publisher", "sessions");
  if (!fs.existsSync(sessionsRoot)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(sessionsRoot, entry.name);
    const session = safeJsonFile(filePath, warnings, `Publication session ${filePath}`);
    if (!isObject(session?.brief)) continue;
    const releaseId = String(session.brief.releaseId || "").toLowerCase();
    if (!isSha256(releaseId) || !ledger.releases[releaseId]) {
      recordUnresolvedReference(ledger, {
        id: `session:${entry.name}:unknown-release`,
        reason: `Publication session references an unknown or invalid release ${releaseId || "(missing)"}`,
        source: "browser-session",
        sourcePath: projectPortablePath(root, filePath),
        releaseId,
      });
      continue;
    }
    const requested = Array.isArray(session.requestedPlatforms) ? session.requestedPlatforms : PRODUCTION_LEDGER_PLATFORMS;
    for (const platform of requested) {
      if (!PRODUCTION_LEDGER_PLATFORMS.includes(platform)) continue;
      const state = isObject(session.platforms?.[platform]) ? session.platforms[platform] : {};
      recordPlatformPublicationAttempt(ledger, {
        id: `browser-session:${session.id || entry.name}:${platform}`,
        releaseId,
        platform,
        source: "browser-session",
        sourcePath: projectPortablePath(root, filePath),
        sessionId: session.id || path.basename(entry.name, ".json"),
        attemptNumber: Number.isInteger(session.attempts?.[platform]) ? session.attempts[platform] : undefined,
        status: state.status || "unknown",
        startedAt: session.createdAt || options.now,
        updatedAt: state.updatedAt || session.updatedAt || session.createdAt || options.now,
        queuePosition: session.brief.queuePosition,
        account: session.accounts?.[platform],
        confirmation: state.confirmation,
        sessionEvidence: state.proof,
      });
      count += 1;
    }
  }
  return count;
}

function scanManualXiaohongshuSessions(root, ledger, warnings, options) {
  const manualRoot = path.join(root, ".agents", "manual-publisher", "xiaohongshu");
  if (!fs.existsSync(manualRoot)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(manualRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".verification.json")) continue;
    const filePath = path.join(manualRoot, entry.name);
    const payload = safeJsonFile(filePath, warnings, `Manual Xiaohongshu panel ${filePath}`);
    if (!isObject(payload)) continue;
    const releaseId = String(payload.releaseId || "").toLowerCase();
    if (!isSha256(releaseId) || !ledger.releases[releaseId]) {
      recordUnresolvedReference(ledger, {
        id: `manual-panel:${entry.name}:unknown-release`,
        reason: `Manual Xiaohongshu panel references an unknown or invalid release ${releaseId || "(missing)"}`,
        source: "manual-xiaohongshu-panel",
        sourcePath: projectPortablePath(root, filePath),
        releaseId,
      });
      continue;
    }
    const verificationPath = filePath.replace(/\.json$/u, ".verification.json");
    const verification = fs.existsSync(verificationPath)
      ? safeJsonFile(verificationPath, warnings, `Manual Xiaohongshu verification ${verificationPath}`)
      : null;
    const stat = fs.statSync(filePath);
    recordPlatformPublicationAttempt(ledger, {
      id: `manual-xiaohongshu-panel:${releaseId}:${entry.name}`,
      releaseId,
      platform: "xiaohongshu",
      source: "manual-xiaohongshu-panel",
      sourcePath: projectPortablePath(root, filePath),
      status: verification?.status || "manual_panel_opened",
      startedAt: payload.launchedAt || stat.mtime.toISOString(),
      updatedAt: verification?.updatedAt || payload.updatedAt || stat.mtime.toISOString(),
      queuePosition: payload.queuePosition,
      account: verification?.account,
      sessionEvidence: verification?.proof,
    });
    // A manual panel or its old verifier is only an attempt/evidence claim. It cannot prove publication.
    count += 1;
  }
  return count;
}

function scanGeneratedTitleIndex(root, ledger, warnings, options) {
  const filePath = path.join(root, "data", "generated-book-titles.txt");
  if (!fs.existsSync(filePath)) return 0;
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  } catch (error) {
    warnings.push(`Generated title index ${filePath}: ${error.message}`);
    return 0;
  }
  const titles = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (const title of titles) {
    recordGeneratedIndexClaim(ledger, {
      displayTitle: title,
      sourcePath: projectPortablePath(root, filePath),
    }, { now: options.now });
  }
  return titles.length;
}

export function rebuildProductionLedgerFromLocalState(root, options = {}) {
  const now = isoNow(options.now);
  const ledger = createProductionLedger({ now });
  const warnings = [];
  const releaseReader = options.releaseReader || ((manifestPath) => readReleasePackage(root, projectPortablePath(root, manifestPath)));
  const renderReader = options.renderReader || ((manifestPath) => readAndValidateRenderManifest(root, manifestPath, {
    verifyMedia: options.verifyMedia !== false,
  }));
  const sourceCounts = {
    validReleases: 0,
    validRenders: 0,
    activeQueueItems: 0,
    archivedQueueItems: 0,
    sessionAttempts: 0,
    manualXiaohongshuAttempts: 0,
    generatedIndexClaims: 0,
  };

  for (const manifestPath of scanReleaseManifestPaths(root)) {
    try {
      const releaseResult = releaseReader(manifestPath);
      recordReleasePackageIntoLedger(ledger, root, manifestPath, releaseResult, warnings, options);
      sourceCounts.validReleases += 1;
    } catch (error) {
      warnings.push(`Invalid release ${projectPortablePath(root, manifestPath)}: ${error.message}`);
    }
  }
  for (const manifestPath of scanRenderManifestPaths(root)) {
    try {
      const renderResult = renderReader(manifestPath);
      recordRenderManifestIntoLedger(ledger, root, manifestPath, renderResult, warnings, options);
      sourceCounts.validRenders += 1;
    } catch (error) {
      warnings.push(`Invalid render ${projectPortablePath(root, manifestPath)}: ${error.message}`);
    }
  }

  const activeQueuePath = path.join(root, ".agents", "publish-queue.json");
  const archiveQueuePath = path.join(root, ".agents", "publish-queue.archive.json");
  for (const descriptor of queueItemsFromFile(root, activeQueuePath, "active", warnings)) {
    recordQueueItemAndPreviousReleases(ledger, descriptor, warnings, options);
    sourceCounts.activeQueueItems += 1;
  }
  for (const descriptor of queueItemsFromFile(root, archiveQueuePath, "archive", warnings)) {
    recordQueueItemAndPreviousReleases(ledger, descriptor, warnings, options);
    sourceCounts.archivedQueueItems += 1;
  }
  sourceCounts.sessionAttempts = scanBrowserSessions(root, ledger, warnings, options);
  sourceCounts.manualXiaohongshuAttempts = scanManualXiaohongshuSessions(root, ledger, warnings, options);
  sourceCounts.generatedIndexClaims = scanGeneratedTitleIndex(root, ledger, warnings, options);
  refreshProductionLedgerPublicationStates(ledger);
  validateProductionLedger(ledger);
  return { ledger, warnings, sourceCounts };
}

function mergeRecords(target, incoming, identity = (item) => item.id) {
  for (const item of incoming) appendUnique(target, structuredClone(item), identity);
}

export function mergeProductionLedgers(base, incoming, options = {}) {
  validateProductionLedger(base, "base production ledger");
  validateProductionLedger(incoming, "incoming production ledger");
  const now = isoNow(options.now);
  const merged = structuredClone(base);
  for (const [workId, work] of Object.entries(incoming.works)) {
    if (!merged.works[workId]) merged.works[workId] = structuredClone(work);
    else {
      mergeRecords(merged.works[workId].generatedIndexClaims, work.generatedIndexClaims);
      merged.works[workId].updatedAt = now;
    }
  }
  for (const [renderSha256, render] of Object.entries(incoming.renders)) {
    if (!merged.renders[renderSha256]) merged.renders[renderSha256] = structuredClone(render);
    else {
      assert(merged.renders[renderSha256].workId === render.workId, `Cannot merge render ${renderSha256} across works`);
      mergeRecords(merged.renders[renderSha256].sources, render.sources);
      merged.renders[renderSha256].validations = sortedUnique([
        ...merged.renders[renderSha256].validations,
        ...render.validations,
      ]);
      merged.renders[renderSha256].lastValidatedAt = [
        merged.renders[renderSha256].lastValidatedAt,
        render.lastValidatedAt,
      ].sort().at(-1);
    }
  }
  for (const [releaseId, release] of Object.entries(incoming.releases)) {
    if (!merged.releases[releaseId]) {
      merged.releases[releaseId] = structuredClone(release);
      continue;
    }
    const target = merged.releases[releaseId];
    assert(target.workId === release.workId, `Cannot merge release ${releaseId} across works`);
    assert(target.renderSha256 === release.renderSha256, `Cannot merge release ${releaseId} with different renders`);
    mergeRecords(target.sources, release.sources);
    mergeRecords(target.queueSnapshots, release.queueSnapshots);
    for (const platform of PRODUCTION_LEDGER_PLATFORMS) {
      mergeRecords(target.platforms[platform].queueStates, release.platforms[platform].queueStates);
      mergeRecords(target.platforms[platform].attempts, release.platforms[platform].attempts);
      mergeRecords(target.platforms[platform].proofs, release.platforms[platform].proofs);
      mergeRecords(target.platforms[platform].retractedProofs, release.platforms[platform].retractedProofs);
    }
  }
  mergeRecords(merged.unresolvedReferences, incoming.unresolvedReferences);
  merged.updatedAt = now;
  refreshProductionLedgerPublicationStates(merged);
  validateProductionLedger(merged);
  return merged;
}

export function migrateProductionLedger(root, options = {}) {
  const rebuilt = rebuildProductionLedgerFromLocalState(root, options);
  const existing = readProductionLedger(root);
  const ledger = existing ? mergeProductionLedgers(existing, rebuilt.ledger, options) : rebuilt.ledger;
  if (options.write !== false) {
    const persisted = writeProductionLedger(root, ledger, { now: options.now });
    return { ...rebuilt, ledger: persisted, filePath: productionLedgerPath(root), wrote: true };
  }
  return { ...rebuilt, ledger, filePath: productionLedgerPath(root), wrote: false };
}

function publicationSummaryForReleases(releases, platform) {
  const proofs = releases.flatMap((release) => activeProofs(release.platforms[platform]).map((proof) => ({
    releaseId: release.releaseId,
    ...proof,
  })));
  const unverifiedReleases = releases
    .filter((release) => release.platforms[platform].publicationState === "unverified")
    .map((release) => release.releaseId);
  const followsDouyin = platform === "xiaohongshu";
  const douyinPublished = followsDouyin && releases.some(
    (release) => activeProofs(release.platforms.douyin).length > 0,
  );
  return {
    trackingMode: followsDouyin ? "follow_douyin" : "verified_platform_proof",
    operationallyComplete: followsDouyin ? douyinPublished : proofs.length > 0,
    everPublished: proofs.length > 0,
    evidenceState: proofs.length > 0 ? "published" : "unverified",
    proofCount: proofs.length,
    proofs,
    unverifiedReleaseIds: unverifiedReleases,
  };
}

export function summarizeProductionWork(ledger, workId) {
  validateProductionLedger(ledger);
  const work = ledger.works[workId];
  assert(work, `Unknown production work: ${workId}`);
  const renders = work.renderSha256s.map((hash) => ledger.renders[hash]).filter(Boolean);
  const releases = work.releaseIds.map((releaseId) => ledger.releases[releaseId]).filter(Boolean);
  return {
    workId: work.workId,
    displayTitle: work.displayTitle,
    author: work.author,
    authorKnown: work.authorKnown,
    everGenerated: renders.length > 0,
    everReleased: releases.length > 0,
    generatedRenderSha256s: [...work.renderSha256s],
    releaseIds: [...work.releaseIds],
    legacyGeneratedIndexClaim: work.generatedIndexClaims.length > 0,
    platforms: Object.fromEntries(PRODUCTION_LEDGER_PLATFORMS.map((platform) => [
      platform,
      publicationSummaryForReleases(releases, platform),
    ])),
  };
}

export function findProductionWorksByIdentity(ledger, displayTitle, author = "") {
  validateProductionLedger(ledger);
  const identity = normalizeProductionIdentity(displayTitle, author);
  if (identity.authorKnown) {
    const workId = createProductionWorkId(identity.displayTitle, identity.author);
    return ledger.works[workId] ? [summarizeProductionWork(ledger, workId)] : [];
  }
  return Object.values(ledger.works)
    .filter((work) => work.titleKey === identity.titleKey)
    .map((work) => summarizeProductionWork(ledger, work.workId));
}

export function summarizeProductionRelease(ledger, releaseId) {
  validateProductionLedger(ledger);
  const normalizedReleaseId = String(releaseId || "").trim().toLowerCase();
  const release = ledger.releases[normalizedReleaseId];
  assert(release, `Unknown production release: ${normalizedReleaseId}`);
  const work = ledger.works[release.workId];
  return {
    releaseId: release.releaseId,
    renderSha256: release.renderSha256,
    workId: release.workId,
    displayTitle: work.displayTitle,
    author: work.author,
    everGenerated: Boolean(ledger.renders[release.renderSha256]),
    platforms: Object.fromEntries(PRODUCTION_LEDGER_PLATFORMS.map((platform) => [
      platform,
      {
        publicationState: release.platforms[platform].publicationState,
        everPublished: release.platforms[platform].publicationState === "published",
        proofCount: activeProofs(release.platforms[platform]).length,
        attemptCount: new Set(
          release.platforms[platform].attempts.map((attempt) => attempt.sessionId || attempt.id),
        ).size,
        latestAttempt: [...release.platforms[platform].attempts]
          .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)))
          .at(-1) || null,
      },
    ])),
  };
}

export function verifyPublishQueueProjection(ledger, queueItems, filePath = "publish-queue.json") {
  validateProductionLedger(ledger);
  assert(Array.isArray(queueItems), `${filePath}: queueItems must be an array`);
  return queueItems.map((item) => {
    const releaseId = String(item?.releaseId || "").trim().toLowerCase();
    assert(isSha256(releaseId), `${filePath}: ${item?.book || "queue item"} has no immutable releaseId`);
    const release = ledger.releases[releaseId];
    assert(release, `${filePath}: release ${releaseId} is missing from production ledger`);
    assert(
      release.renderSha256 === String(item.renderSha256 || "").trim().toLowerCase(),
      `${filePath}: release ${releaseId} render hash differs from production ledger`,
    );
    for (const platform of PRODUCTION_LEDGER_PLATFORMS) {
      if (platform === "xiaohongshu") continue;
      const queueStatus = item[`${platform}Status`];
      const ledgerPublished = release.platforms[platform].publicationState === "published";
      assert(
        !(queueStatus === "published" && !ledgerPublished),
        `${filePath}: ${platform} is published without trusted ledger proof for release ${releaseId}`,
      );
      assert(
        !(queueStatus === "pending" && ledgerPublished),
        `${filePath}: ${platform} is pending although release ${releaseId} already has trusted proof`,
      );
    }
    return summarizeProductionRelease(ledger, releaseId);
  });
}
