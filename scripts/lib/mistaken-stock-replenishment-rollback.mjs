import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { replaceFilesWithRollback } from "./file-transaction.mjs";
import { writeFileAtomically } from "./filesystem.mjs";
import { readJsonFile } from "./json.mjs";
import {
  MISTAKEN_STOCK_REPLENISHMENT_ARCHIVE_KIND,
  readPublishQueue,
  readPublishQueueArchive,
  validatePublishQueueArchiveObject,
  validatePublishQueueObject,
} from "./publish-queue.mjs";
import { readProductionLedger } from "./production-ledger.mjs";
import {
  readReplenishmentBatch,
  validateReplenishmentBatch,
} from "./replenishment-batch.mjs";
import { readReleasePackage } from "./release-package.mjs";

export const MISTAKEN_STOCK_REPLENISHMENT_ROLLBACK_KIND = "book-video-mistaken-stock-replenishment-rollback";

const ARCHIVE_REASON = "mistaken-stock-replenishment";
const ROLLBACKS_DIRECTORY = "mistaken-stock-replenishment-rollbacks";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || ""));
}

function normalizeSha256(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  assert(isSha256(normalized), `${label} must be a sha256 hex string`);
  return normalized;
}

function isoNow(value) {
  const text = value instanceof Date
    ? value.toISOString()
    : String(value || new Date().toISOString());
  assert(Number.isFinite(Date.parse(text)), `Expected an ISO date, got ${text}`);
  return text;
}

function normalizedRoot(root) {
  return path.resolve(root);
}

function agentsDirectory(root) {
  return path.join(root, ".agents");
}

function batchPath(root) {
  return path.join(agentsDirectory(root), "stock-replenishment.json");
}

function queuePath(root) {
  return path.join(agentsDirectory(root), "publish-queue.json");
}

function queueArchivePath(root) {
  return path.join(agentsDirectory(root), "publish-queue.archive.json");
}

function rollbackRecordPath(root, rollbackId) {
  return path.join(agentsDirectory(root), ROLLBACKS_DIRECTORY, `${rollbackId}.json`);
}

function toPortablePath(root, filePath) {
  const relative = path.relative(root, filePath);
  assert(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), `Path escapes project root: ${filePath}`);
  return relative.split(path.sep).join("/");
}

function targetKey(item) {
  return `${item.book}:${String(item.releaseId).toLowerCase()}:${String(item.renderSha256).toLowerCase()}`;
}

function targetSummary(target) {
  return {
    book: target.book,
    releaseId: target.releaseId,
    renderSha256: target.renderSha256,
    position: target.item.position,
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

function acquireWriteLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const existing = readJsonFile(lockPath);
      stale = !processIsRunning(Number(existing?.pid));
    } catch {
      // An unreadable lock may be in the process of being written; leave it alone.
    }
    if (!stale) throw new Error(`Rollback update is already in progress: ${lockPath}`, { cause: error });
    fs.rmSync(lockPath, { force: true });
    handle = fs.openSync(lockPath, "wx");
  }
  try {
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
  } catch (error) {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
    throw error;
  }
  return () => {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  };
}

function withRollbackWriteLocks(root, operation) {
  const directory = agentsDirectory(root);
  const lockPaths = [
    path.join(directory, "mistaken-stock-replenishment-rollback.lock"),
    path.join(directory, "publish-queue.lock"),
    path.join(directory, "stock-replenishment.lock"),
  ];
  const releaseLocks = [];
  try {
    for (const lockPath of lockPaths) releaseLocks.push(acquireWriteLock(lockPath));
    return operation();
  } finally {
    for (const release of releaseLocks.reverse()) release();
  }
}

function validateBoundBatchItems(batch) {
  const targets = [];
  const keys = new Set();
  for (const item of batch.items) {
    if (item.stage !== "publishable") {
      assert(item.releaseId === undefined && item.renderSha256 === undefined, `Stock replenishment batch ${batch.batchId} pending item ${item.book} has a release binding`);
      continue;
    }
    assert(item.releaseId !== undefined, `Stock replenishment batch ${batch.batchId} item ${item.book} is legacy_unpinned and cannot be rolled back safely`);
    const target = {
      book: item.book,
      releaseId: normalizeSha256(item.releaseId, `Batch item ${item.book} releaseId`),
      renderSha256: normalizeSha256(item.renderSha256, `Batch item ${item.book} renderSha256`),
      batchItem: item,
    };
    const key = targetKey(target);
    assert(!keys.has(key), `Stock replenishment batch ${batch.batchId} contains duplicate immutable release binding ${item.book}`);
    keys.add(key);
    targets.push(target);
  }
  assert(targets.length > 0, `Stock replenishment batch ${batch.batchId} has no immutable queue releases to roll back`);
  return targets;
}

function validateQueueTarget(root, queue, target) {
  const byBook = queue.items.filter((item) => item.book === target.book);
  assert(byBook.length === 1, `Publication queue must contain exactly one entry for batch item ${target.book}, found ${byBook.length}`);
  const item = byBook[0];
  assert(item.releaseId === target.releaseId, `Publication queue item ${target.book} releaseId does not match the current batch binding`);
  assert(
    String(item.renderSha256).toLowerCase() === target.renderSha256,
    `Publication queue item ${target.book} renderSha256 does not match the current batch binding`,
  );
  const releaseResult = readReleasePackage(root, item.releaseManifestPath);
  assert(releaseResult.release.releaseId === target.releaseId, `Release package for ${target.book} does not match the current batch releaseId`);
  assert(
    releaseResult.release.video.sha256 === target.renderSha256,
    `Release package for ${target.book} does not match the current batch renderSha256`,
  );
  assert(releaseResult.release.episode.name === target.book, `Release package for ${target.book} belongs to another episode`);
  target.item = structuredClone(item);
  target.releaseManifestPath = item.releaseManifestPath;
}

function archiveEntryFor(target, metadata) {
  return {
    archivedAt: metadata.archivedAt,
    reason: ARCHIVE_REASON,
    correction: {
      kind: MISTAKEN_STOCK_REPLENISHMENT_ARCHIVE_KIND,
      rollbackId: metadata.rollbackId,
      batchId: metadata.batchId,
      recordPath: metadata.recordPath,
      releaseId: target.releaseId,
      renderSha256: target.renderSha256,
    },
    item: structuredClone(target.item),
  };
}

function isTargetItem(item, targetKeys) {
  return targetKeys.has(targetKey(item));
}

function assertNoArchivedTargetCollision(archive, targets) {
  const archivedKeys = new Set(archive.items.map((entry) => targetKey(entry.item)));
  for (const target of targets) {
    assert(
      !archivedKeys.has(targetKey(target)),
      `Publication queue archive already contains the immutable batch release for ${target.book}; refusing to overwrite recovery history`,
    );
  }
}

export function validateMistakenStockReplenishmentRollbackRecord(record, filePath = "mistaken-stock-replenishment-rollback.json") {
  assert(record && typeof record === "object" && !Array.isArray(record), `${filePath}: root must be an object`);
  assert(record.schemaVersion === 1, `${filePath}: schemaVersion must be 1`);
  assert(record.kind === MISTAKEN_STOCK_REPLENISHMENT_ROLLBACK_KIND, `${filePath}: kind is invalid`);
  assert(typeof record.rollbackId === "string" && record.rollbackId.trim(), `${filePath}: rollbackId must be non-empty`);
  assert(typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt)), `${filePath}: createdAt must be an ISO date`);
  assert(record.reason === ARCHIVE_REASON, `${filePath}: reason is invalid`);
  assert(record.batch && typeof record.batch === "object" && !Array.isArray(record.batch), `${filePath}: batch must be an object`);
  assert(typeof record.batch.path === "string" && record.batch.path.trim(), `${filePath}: batch path must be non-empty`);
  validateReplenishmentBatch(record.batch.before, `${filePath}: batch.before`);
  validateReplenishmentBatch(record.batch.after, `${filePath}: batch.after`);
  assert(record.batch.after.status === "archived", `${filePath}: batch.after must be archived`);
  assert(record.batch.after.retirement?.rollbackId === record.rollbackId, `${filePath}: batch rollbackId mismatch`);
  assert(record.queue && typeof record.queue === "object" && !Array.isArray(record.queue), `${filePath}: queue must be an object`);
  assert(typeof record.queue.path === "string" && record.queue.path.trim(), `${filePath}: queue path must be non-empty`);
  assert(typeof record.queue.archivePath === "string" && record.queue.archivePath.trim(), `${filePath}: queue archivePath must be non-empty`);
  assert(Array.isArray(record.queue.removedItems) && record.queue.removedItems.length > 0, `${filePath}: removedItems must be non-empty`);
  assert(Array.isArray(record.queue.archivedEntries) && record.queue.archivedEntries.length === record.queue.removedItems.length, `${filePath}: archivedEntries must match removedItems`);
  const removedKeys = new Set();
  for (const item of record.queue.removedItems) {
    validatePublishQueueObject({ updatedAt: record.createdAt, items: [item] }, filePath);
    const key = targetKey(item);
    assert(!removedKeys.has(key), `${filePath}: duplicate removed queue release ${item.book}`);
    removedKeys.add(key);
  }
  for (const entry of record.queue.archivedEntries) {
    validatePublishQueueArchiveObject({ updatedAt: record.createdAt, items: [entry] }, filePath);
    assert(entry.correction?.rollbackId === record.rollbackId, `${filePath}: archived entry rollbackId mismatch`);
    assert(removedKeys.has(targetKey(entry.item)), `${filePath}: archived entry was not removed from the active queue`);
  }
  assert(record.recovery && typeof record.recovery === "object" && !Array.isArray(record.recovery), `${filePath}: recovery must be an object`);
  assert(record.recovery.queueItemsRetained === true, `${filePath}: recovery must retain queue items`);
  assert(record.recovery.releaseArtifactsRetained === true, `${filePath}: recovery must retain release artifacts`);
  assert(record.recovery.productionLedgerRetained === true, `${filePath}: recovery must retain production ledger history`);
  return record;
}

export function readMistakenStockReplenishmentRollbackRecord(root, rollbackId) {
  const resolvedRoot = normalizedRoot(root);
  const filePath = rollbackRecordPath(resolvedRoot, String(rollbackId || "").trim());
  assert(fs.existsSync(filePath), `Missing mistaken stock replenishment rollback record: ${filePath}`);
  return validateMistakenStockReplenishmentRollbackRecord(readJsonFile(filePath), filePath);
}

function buildRollbackPlan(root, options = {}) {
  const batch = readReplenishmentBatch(root, { required: true });
  assert(batch.status !== "archived", `Stock replenishment batch ${batch.batchId} is already archived`);
  assert(["active", "complete"].includes(batch.status), `Stock replenishment batch ${batch.batchId} cannot be rolled back from status ${batch.status}`);
  // Validate the existing historical ledger before queue state changes. The rollback never mutates it.
  readProductionLedger(root, { required: true });
  const queue = readPublishQueue(root, { required: true });
  const archive = readPublishQueueArchive(root);
  const targets = validateBoundBatchItems(batch);
  for (const target of targets) validateQueueTarget(root, queue, target);
  assertNoArchivedTargetCollision(archive, targets);
  return { root, batch, queue, archive, targets, now: isoNow(options.now) };
}

function createRollbackState(plan, rollbackId) {
  assert(/^[a-z0-9][a-z0-9-]{0,127}$/iu.test(rollbackId), `Invalid rollbackId: ${rollbackId}`);
  const recordPath = rollbackRecordPath(plan.root, rollbackId);
  assert(!fs.existsSync(recordPath), `Rollback record already exists: ${recordPath}`);
  const recordPortablePath = toPortablePath(plan.root, recordPath);
  const metadata = {
    rollbackId,
    batchId: plan.batch.batchId,
    archivedAt: plan.now,
    recordPath: recordPortablePath,
  };
  const archivedEntries = plan.targets.map((target) => archiveEntryFor(target, metadata));
  const targetKeys = new Set(plan.targets.map(targetKey));
  const nextQueue = {
    ...plan.queue,
    updatedAt: plan.now,
    items: plan.queue.items.filter((item) => !isTargetItem(item, targetKeys)),
  };
  validatePublishQueueObject(nextQueue, queuePath(plan.root));
  const nextArchive = {
    updatedAt: plan.now,
    items: [...plan.archive.items, ...archivedEntries],
  };
  validatePublishQueueArchiveObject(nextArchive, queueArchivePath(plan.root));
  const retirement = {
    kind: ARCHIVE_REASON,
    rollbackId,
    retiredAt: plan.now,
    recordPath: recordPortablePath,
    archivedQueueReleases: plan.targets.map((target) => ({
      book: target.book,
      releaseId: target.releaseId,
      renderSha256: target.renderSha256,
    })),
  };
  const nextBatch = {
    ...structuredClone(plan.batch),
    status: "archived",
    retirement,
  };
  validateReplenishmentBatch(nextBatch, batchPath(plan.root));
  const record = {
    schemaVersion: 1,
    kind: MISTAKEN_STOCK_REPLENISHMENT_ROLLBACK_KIND,
    rollbackId,
    createdAt: plan.now,
    reason: ARCHIVE_REASON,
    batch: {
      path: toPortablePath(plan.root, batchPath(plan.root)),
      before: structuredClone(plan.batch),
      after: structuredClone(nextBatch),
    },
    queue: {
      path: toPortablePath(plan.root, queuePath(plan.root)),
      archivePath: toPortablePath(plan.root, queueArchivePath(plan.root)),
      removedItems: plan.targets.map((target) => structuredClone(target.item)),
      archivedEntries: structuredClone(archivedEntries),
    },
    recovery: {
      queueItemsRetained: true,
      releaseArtifactsRetained: true,
      productionLedgerRetained: true,
    },
  };
  validateMistakenStockReplenishmentRollbackRecord(record, recordPath);
  return { ...metadata, recordPath, archivedEntries, nextQueue, nextArchive, nextBatch, record };
}

function resultFromState(plan, state, apply) {
  return {
    apply,
    changed: apply,
    batchId: plan.batch.batchId,
    rollbackId: state.rollbackId,
    archivedAt: state.archivedAt,
    archivedCount: plan.targets.length,
    queueRemainingCount: state.nextQueue.items.length,
    targets: plan.targets.map(targetSummary),
    queuePath: queuePath(plan.root),
    queueArchivePath: queueArchivePath(plan.root),
    batchPath: batchPath(plan.root),
    rollbackRecordPath: state.recordPath,
    recovery: {
      queueItemsRetained: true,
      releaseArtifactsRetained: true,
      productionLedgerRetained: true,
      cleanupProtected: true,
    },
  };
}

function assertPersistedRollback(plan, state) {
  const persistedQueue = readPublishQueue(plan.root, { required: true });
  const persistedArchive = readPublishQueueArchive(plan.root);
  const persistedBatch = readReplenishmentBatch(plan.root, { required: true });
  const persistedRecord = readMistakenStockReplenishmentRollbackRecord(plan.root, state.rollbackId);
  assert(JSON.stringify(persistedQueue) === JSON.stringify(state.nextQueue), "Publication queue rollback state did not persist exactly");
  assert(JSON.stringify(persistedArchive) === JSON.stringify(state.nextArchive), "Publication queue archive rollback state did not persist exactly");
  assert(JSON.stringify(persistedBatch) === JSON.stringify(state.nextBatch), "Stock replenishment retirement state did not persist exactly");
  assert(JSON.stringify(persistedRecord) === JSON.stringify(state.record), "Rollback correction record did not persist exactly");
  for (const target of plan.targets) {
    assert(!persistedQueue.items.some((item) => targetKey(item) === targetKey(target)), `Rolled-back queue release remains active: ${target.book}`);
    const archived = persistedArchive.items.find((entry) => targetKey(entry.item) === targetKey(target));
    assert(archived?.correction?.rollbackId === state.rollbackId, `Rolled-back queue release is missing correction archive metadata: ${target.book}`);
    const releaseResult = readReleasePackage(plan.root, target.releaseManifestPath);
    assert(releaseResult.release.releaseId === target.releaseId, `Release artifact changed during rollback: ${target.book}`);
    assert(releaseResult.release.video.sha256 === target.renderSha256, `Release artifact hash changed during rollback: ${target.book}`);
  }
}

function writeCandidate(filePath, value) {
  writeFileAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
}

export function rollbackMistakenStockReplenishment(root, options = {}) {
  const resolvedRoot = normalizedRoot(root);
  const apply = options.apply === true;
  const rollbackId = String(options.rollbackId || randomUUID()).trim();
  if (!apply) {
    const plan = buildRollbackPlan(resolvedRoot, options);
    const state = createRollbackState(plan, rollbackId);
    return resultFromState(plan, state, false);
  }
  return withRollbackWriteLocks(resolvedRoot, () => {
    const plan = buildRollbackPlan(resolvedRoot, options);
    const state = createRollbackState(plan, rollbackId);
    const temporaryDirectory = path.join(
      agentsDirectory(resolvedRoot),
      `.mistaken-stock-replenishment-rollback-${rollbackId}.${process.pid}.tmp`,
    );
    assert(!fs.existsSync(temporaryDirectory), `Rollback temporary directory already exists: ${temporaryDirectory}`);
    fs.mkdirSync(temporaryDirectory, { recursive: true });
    try {
      const queueCandidate = path.join(temporaryDirectory, "publish-queue.json");
      const archiveCandidate = path.join(temporaryDirectory, "publish-queue.archive.json");
      const batchCandidate = path.join(temporaryDirectory, "stock-replenishment.json");
      const recordCandidate = path.join(temporaryDirectory, "rollback-record.json");
      writeCandidate(queueCandidate, state.nextQueue);
      writeCandidate(archiveCandidate, state.nextArchive);
      writeCandidate(batchCandidate, state.nextBatch);
      writeCandidate(recordCandidate, state.record);
      replaceFilesWithRollback([
        { source: archiveCandidate, destination: queueArchivePath(resolvedRoot) },
        { source: queueCandidate, destination: queuePath(resolvedRoot) },
        { source: batchCandidate, destination: batchPath(resolvedRoot) },
        { source: recordCandidate, destination: state.recordPath },
      ], path.join(temporaryDirectory, "backups"), () => assertPersistedRollback(plan, state));
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    return resultFromState(plan, state, true);
  });
}
