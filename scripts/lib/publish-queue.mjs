import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./filesystem.mjs";
import { readJsonFile } from "./json.mjs";
import { readReleasePackage } from "./release-package.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeAbsolutePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function queuePathFor(root) {
  return path.join(root, ".agents", "publish-queue.json");
}

const PLATFORM_FIELDS = {
  douyin: {
    status: "douyinStatus",
    publication: "douyinPublication",
    officialHosts: ["creator.douyin.com", "www.douyin.com", "douyin.com"],
  },
  xiaohongshu: {
    status: "xiaohongshuStatus",
    publication: "xiaohongshuPublication",
    officialHosts: ["creator.xiaohongshu.com", "www.xiaohongshu.com", "xiaohongshu.com"],
  },
};

const PLATFORM_STATUSES = new Set(["pending", "published"]);

function bindPublicationToRelease(publication, releaseId, renderSha256) {
  if (!publication) return undefined;
  return {
    ...publication,
    releaseId: publication.releaseId || releaseId,
    renderSha256: publication.renderSha256 || renderSha256,
  };
}

function previousReleaseSnapshot(item, supersededAt) {
  return {
    releaseId: item.releaseId || String(item.renderSha256).toLowerCase(),
    renderSha256: String(item.renderSha256).toLowerCase(),
    scriptVersion: item.scriptVersion,
    videoPath: item.videoPath,
    title: item.title,
    description: item.description,
    douyinStatus: item.douyinStatus,
    xiaohongshuStatus: item.xiaohongshuStatus,
    ...(item.releaseManifestPath ? { releaseManifestPath: item.releaseManifestPath } : {}),
    ...(item.douyinPublication ? { douyinPublication: item.douyinPublication } : {}),
    ...(item.xiaohongshuPublication ? { xiaohongshuPublication: item.xiaohongshuPublication } : {}),
    supersededAt,
  };
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

function openQueueLock(lockPath) {
  try {
    return fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const lock = readJsonFile(lockPath);
      stale = !processIsRunning(Number(lock.pid));
    } catch {
      // An unreadable lock may be in the process of being written; keep it.
    }
    if (!stale) {
      throw new Error(`Publication queue update is already in progress: ${lockPath}`, { cause: error });
    }
    fs.rmSync(lockPath, { force: true });
    return fs.openSync(lockPath, "wx");
  }
}

function withQueueWriteLock(root, operation) {
  const agentsDir = path.join(root, ".agents");
  const lockPath = path.join(agentsDir, "publish-queue.lock");
  fs.mkdirSync(agentsDir, { recursive: true });
  const handle = openQueueLock(lockPath);
  try {
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    return operation();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

export function validatePublishQueueObject(data, filePath = "publish-queue.json") {
  assert(data && typeof data === "object" && !Array.isArray(data), `${filePath}: root must be an object`);
  assert(typeof data.updatedAt === "string" && data.updatedAt.trim(), `${filePath}: updatedAt must be a non-empty string`);
  assert(Array.isArray(data.items), `${filePath}: items must be an array`);

  const books = new Set();
  const positions = new Set();
  for (const item of data.items) {
    assert(item && typeof item === "object" && !Array.isArray(item), `${filePath}: every item must be an object`);
    assert(Number.isInteger(item.position) && item.position > 0, `${filePath}: item.position must be a positive integer`);
    assert(!positions.has(item.position), `${filePath}: duplicate queue position ${item.position}`);
    positions.add(item.position);
    assert(typeof item.book === "string" && item.book.trim(), `${filePath}: item.book must be a non-empty string`);
    assert(!books.has(item.book), `${filePath}: duplicate queue entry for ${item.book}`);
    books.add(item.book);
    assert(typeof item.videoPath === "string" && path.isAbsolute(item.videoPath), `${filePath}: item.videoPath must be absolute`);
    assert(typeof item.title === "string" && item.title.trim(), `${filePath}: item.title must be a non-empty string`);
    assert(typeof item.description === "string" && item.description.trim(), `${filePath}: item.description must be a non-empty string`);
    assert(typeof item.scriptVersion === "string" && item.scriptVersion.trim(), `${filePath}: item.scriptVersion must be a non-empty string`);
    assert(/^[a-f0-9]{64}$/iu.test(String(item.renderSha256)), `${filePath}: item.renderSha256 must be a sha256 hex string`);
    assert(PLATFORM_STATUSES.has(item.douyinStatus), `${filePath}: unsupported item.douyinStatus ${item.douyinStatus}`);
    assert(PLATFORM_STATUSES.has(item.xiaohongshuStatus), `${filePath}: unsupported item.xiaohongshuStatus ${item.xiaohongshuStatus}`);
    assert(typeof item.createdAt === "string" && item.createdAt.trim(), `${filePath}: item.createdAt must be a non-empty string`);
    if (item.releaseId !== undefined || item.releaseManifestPath !== undefined) {
      assert(/^[a-f0-9]{64}$/u.test(String(item.releaseId)), `${filePath}: item.releaseId must be a sha256 hex string`);
      assert(
        typeof item.releaseManifestPath === "string" && item.releaseManifestPath.trim(),
        `${filePath}: item.releaseManifestPath must be non-empty`,
      );
    }
    for (const [platform, fields] of Object.entries(PLATFORM_FIELDS)) {
      const publication = item[fields.publication];
      if (publication === undefined) continue;
      assert(publication && typeof publication === "object" && !Array.isArray(publication), `${filePath}: item.${fields.publication} must be an object`);
      assert(publication.platform === platform, `${filePath}: item.${fields.publication}.platform must be ${platform}`);
      assert(typeof publication.verifiedAt === "string" && Number.isFinite(Date.parse(publication.verifiedAt)), `${filePath}: item.${fields.publication}.verifiedAt must be an ISO date`);
      assert(typeof publication.signal === "string" && publication.signal.trim(), `${filePath}: item.${fields.publication}.signal must be non-empty`);
      assert(typeof publication.url === "string" && publication.url.trim(), `${filePath}: item.${fields.publication}.url must be non-empty`);
      const proofUrl = new URL(publication.url);
      assert(proofUrl.protocol === "https:", `${filePath}: item.${fields.publication}.url must use https`);
      assert(fields.officialHosts.includes(proofUrl.hostname), `${filePath}: item.${fields.publication}.url must use an official ${platform} host`);
      if (publication.workId !== undefined) {
        assert(typeof publication.workId === "string" && publication.workId.trim(), `${filePath}: item.${fields.publication}.workId must be non-empty`);
      }
      if (publication.releaseId !== undefined || publication.renderSha256 !== undefined) {
        assert(publication.releaseId === item.releaseId, `${filePath}: item.${fields.publication}.releaseId mismatch`);
        assert(
          publication.renderSha256 === String(item.renderSha256).toLowerCase(),
          `${filePath}: item.${fields.publication}.renderSha256 mismatch`,
        );
      }
    }
    if (item.previousReleases !== undefined) {
      assert(Array.isArray(item.previousReleases), `${filePath}: item.previousReleases must be an array`);
      for (const previous of item.previousReleases) {
        assert(/^[a-f0-9]{64}$/u.test(String(previous?.releaseId)), `${filePath}: previous releaseId is invalid`);
        assert(/^[a-f0-9]{64}$/u.test(String(previous?.renderSha256)), `${filePath}: previous renderSha256 is invalid`);
        assert(Number.isFinite(Date.parse(previous.supersededAt)), `${filePath}: previous supersededAt must be an ISO date`);
      }
    }
  }

  return data;
}

export function readPublishQueue(root, options = {}) {
  const filePath = queuePathFor(root);
  if (!fs.existsSync(filePath)) {
    if (options.required) throw new Error(`Missing publication queue: ${filePath}`);
    return null;
  }
  return validatePublishQueueObject(readJsonFile(filePath), filePath);
}

export function assertPublishQueueItemMatchesResult(item, result, filePath = "publish-queue.json", root = "") {
  assert(item, `${filePath}: missing queue entry for ${result.episodeName}`);
  assert(item.book === result.episodeName, `${filePath}: book does not match completed episode`);
  assert(
    normalizeAbsolutePath(item.videoPath) === normalizeAbsolutePath(result.outputPath),
    `${filePath}: videoPath does not match render manifest`,
  );
  assert(item.scriptVersion === result.manifest.episode.scriptVersion, `${filePath}: scriptVersion does not match render manifest`);
  assert(
    String(item.renderSha256).toLowerCase() === result.manifest.output.sha256.toLowerCase(),
    `${filePath}: renderSha256 does not match render manifest`,
  );
  if (result.publish) {
    assert(item.title === result.publish.copy.selectedTitle, `${filePath}: title does not match publish.json`);
    assert(item.description === result.publish.copy.description, `${filePath}: description does not match publish.json`);
  }
  if (item.releaseId !== undefined) {
    assert(root, `${filePath}: repository root is required to validate release`);
    const releaseResult = readReleasePackage(root, item.releaseManifestPath);
    assert(releaseResult.release.releaseId === item.releaseId, `${filePath}: releaseId does not match release package`);
    assert(
      normalizeAbsolutePath(releaseResult.videoPath) !== normalizeAbsolutePath(result.outputPath),
      `${filePath}: release video must be immutable and separate from the active render`,
    );
    assert(releaseResult.release.episode.name === result.episodeName, `${filePath}: release episode does not match completed episode`);
    assert(
      releaseResult.release.episode.scriptVersion === result.manifest.episode.scriptVersion,
      `${filePath}: release scriptVersion does not match completed episode`,
    );
    assert(releaseResult.release.video.sha256 === result.manifest.output.sha256.toLowerCase(), `${filePath}: release hash does not match completed episode`);
  }
  return item;
}

export function requirePublishQueueItem(root, result) {
  const filePath = queuePathFor(root);
  const queue = readPublishQueue(root, { required: true });
  const matches = queue.items.filter((item) => item.book === result.episodeName);
  assert(matches.length === 1, `${filePath}: expected exactly one queue entry for ${result.episodeName}, found ${matches.length}`);
  return assertPublishQueueItemMatchesResult(matches[0], result, filePath, root);
}

function buildQueueItem(queue, result, nowText) {
  assert(result.publish, `Missing publish.json: ${result.publishPath}`);
  assert(result.release?.release, "Completed episode must have an immutable release package before queue enrollment");
  const existing = queue.items.find((item) => item.book === result.episodeName);
  const maxPosition = queue.items.reduce((max, item) => Math.max(max, item.position), 0);
  const renderSha256 = result.manifest.output.sha256.toLowerCase();
  const releaseId = result.release.release.releaseId;
  assert(/^[a-f0-9]{64}$/u.test(releaseId), "Release id is invalid");
  const matchingLegacyRelease = Boolean(
    existing
    && !existing.releaseId
    && String(existing.renderSha256).toLowerCase() === renderSha256
    && existing.scriptVersion === result.manifest.episode.scriptVersion
    && existing.title === result.publish.copy.selectedTitle
    && existing.description === result.publish.copy.description,
  );
  const releaseChanged = Boolean(
    existing
    && !matchingLegacyRelease
    && existing.releaseId !== releaseId,
  );
  const previousReleases = [
    ...(existing?.previousReleases || []),
    ...(releaseChanged ? [previousReleaseSnapshot(existing, nowText)] : []),
  ];
  const item = {
    position: existing?.position || maxPosition + 1,
    book: result.episodeName,
    videoPath: path.resolve(result.outputPath),
    title: result.publish.copy.selectedTitle,
    description: result.publish.copy.description,
    scriptVersion: result.manifest.episode.scriptVersion,
    renderSha256,
    releaseId,
    releaseManifestPath: result.release.manifestPortablePath,
    douyinStatus: releaseChanged ? "pending" : (existing?.douyinStatus || "pending"),
    xiaohongshuStatus: releaseChanged ? "pending" : (existing?.xiaohongshuStatus || "pending"),
    createdAt: existing?.createdAt || nowText,
    ...(previousReleases.length ? { previousReleases } : {}),
  };
  if (!releaseChanged) {
    const douyinPublication = bindPublicationToRelease(existing?.douyinPublication, releaseId, renderSha256);
    const xiaohongshuPublication = bindPublicationToRelease(existing?.xiaohongshuPublication, releaseId, renderSha256);
    if (douyinPublication) item.douyinPublication = douyinPublication;
    if (xiaohongshuPublication) item.xiaohongshuPublication = xiaohongshuPublication;
  }
  return item;
}

export function upsertCompletedEpisodeIntoPublishQueue(root, result, options = {}) {
  return withQueueWriteLock(root, () => {
    const filePath = queuePathFor(root);
    const nowText = options.now instanceof Date
      ? options.now.toISOString()
      : String(options.now || new Date().toISOString());
    const current = readPublishQueue(root) || { updatedAt: nowText, items: [] };
    const item = buildQueueItem(current, result, nowText);
    const items = current.items.some((entry) => entry.book === result.episodeName)
      ? current.items.map((entry) => (entry.book === result.episodeName ? item : entry))
      : [...current.items, item];
    const next = {
      ...current,
      updatedAt: nowText,
      items: items.sort((left, right) => left.position - right.position),
    };
    validatePublishQueueObject(next, filePath);

    writeFileAtomically(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
    const persisted = readPublishQueue(root, { required: true });
    const persistedItem = persisted.items.find((entry) => entry.book === result.episodeName);
    assertPublishQueueItemMatchesResult(persistedItem, result, filePath, root);
    return { queue: persisted, item: persistedItem, filePath };
  });
}

function normalizePublicationProof(platform, proof, verifiedAt, releaseId, renderSha256) {
  const fields = PLATFORM_FIELDS[platform];
  assert(fields, `Unsupported publication platform: ${platform}`);
  assert(proof && typeof proof === "object" && !Array.isArray(proof), `${platform} publication proof must be an object`);
  const url = String(proof.url || "").trim();
  const signal = String(proof.signal || "").trim();
  assert(url, `${platform} publication proof requires url`);
  assert(signal, `${platform} publication proof requires signal`);
  if (proof.releaseId !== undefined) {
    assert(proof.releaseId === releaseId, `${platform} publication proof releaseId mismatch`);
  }
  if (proof.renderSha256 !== undefined) {
    assert(proof.renderSha256 === renderSha256, `${platform} publication proof renderSha256 mismatch`);
  }
  const parsedUrl = new URL(url);
  assert(parsedUrl.protocol === "https:", `${platform} publication proof URL must use https`);
  assert(fields.officialHosts.includes(parsedUrl.hostname), `${platform} publication proof URL must use an official host`);
  const workId = String(proof.workId || "").trim();
  return {
    platform,
    releaseId,
    renderSha256,
    verifiedAt,
    signal,
    url: parsedUrl.toString(),
    ...(workId ? { workId } : {}),
  };
}

export function markPublishQueuePlatformPublished(root, options = {}) {
  const platform = String(options.platform || "").trim();
  const fields = PLATFORM_FIELDS[platform];
  assert(fields, `Unsupported publication platform: ${platform}`);
  const book = String(options.book || "").trim();
  assert(book, "Publication queue update requires book");
  const expectedRenderSha256 = String(options.expectedRenderSha256 || "").trim().toLowerCase();
  assert(/^[a-f0-9]{64}$/u.test(expectedRenderSha256), "Publication queue update requires expectedRenderSha256");

  return withQueueWriteLock(root, () => {
    const filePath = queuePathFor(root);
    const current = readPublishQueue(root, { required: true });
    const matches = current.items.filter((entry) => entry.book === book);
    assert(matches.length === 1, `${filePath}: expected exactly one queue entry for ${book}, found ${matches.length}`);
    const existing = matches[0];
    assert(existing.releaseId, `${filePath}: finalize ${book} again before recording publication`);
    assert(
      String(existing.renderSha256).toLowerCase() === expectedRenderSha256,
      `${filePath}: refusing to publish status for a different render hash`,
    );

    const verifiedAt = options.now instanceof Date
      ? options.now.toISOString()
      : String(options.now || new Date().toISOString());
    assert(Number.isFinite(Date.parse(verifiedAt)), "Publication verification time must be an ISO date");
    const publication = normalizePublicationProof(
      platform,
      options.proof,
      verifiedAt,
      existing.releaseId,
      expectedRenderSha256,
    );
    const previousOtherStatuses = Object.fromEntries(
      Object.entries(PLATFORM_FIELDS)
        .filter(([name]) => name !== platform)
        .map(([, value]) => [value.status, existing[value.status]]),
    );

    if (existing[fields.status] === "published") {
      const persistedPublication = existing[fields.publication];
      if (persistedPublication) {
        assert(
          persistedPublication.url === publication.url
          && persistedPublication.signal === publication.signal
          && (persistedPublication.workId || "") === (publication.workId || ""),
          `${filePath}: ${platform} is already published with different proof`,
        );
      }
      return { queue: current, item: existing, filePath, changed: false };
    }
    assert(existing[fields.status] === "pending", `${filePath}: ${platform} status must be pending before publication`);

    const nextItem = {
      ...existing,
      [fields.status]: "published",
      [fields.publication]: publication,
    };
    const next = {
      ...current,
      updatedAt: verifiedAt,
      items: current.items.map((entry) => (entry.book === book ? nextItem : entry)),
    };
    validatePublishQueueObject(next, filePath);
    writeFileAtomically(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });

    const persisted = readPublishQueue(root, { required: true });
    const persistedItem = persisted.items.find((entry) => entry.book === book);
    assert(persistedItem?.[fields.status] === "published", `${filePath}: ${platform} status was not persisted`);
    assert(
      persistedItem?.[fields.publication]?.url === publication.url,
      `${filePath}: ${platform} publication proof was not persisted`,
    );
    for (const [statusField, expectedStatus] of Object.entries(previousOtherStatuses)) {
      assert(persistedItem[statusField] === expectedStatus, `${filePath}: unrelated platform status changed`);
    }
    return { queue: persisted, item: persistedItem, filePath, changed: true };
  });
}
