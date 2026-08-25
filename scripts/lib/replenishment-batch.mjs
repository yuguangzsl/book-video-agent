import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./filesystem.mjs";
import { checkBookEligibility } from "./generated-title-index.mjs";
import { readJsonFile } from "./json.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function matchingEntries(value) {
  return Array.isArray(value) ? value : [];
}

function stockEligibility(root, book, options = {}) {
  const checker = options.checkBookEligibility || checkBookEligibility;
  return checker(root, book, {
    ...(options.eligibilityOptions || {}),
    maintenance: false,
  });
}

function stockEligibilityBlockers(eligibility, options = {}) {
  const matches = eligibility?.matches || {};
  const titleIndex = matchingEntries(matches.titleIndex);
  const validatedRenders = matchingEntries(matches.validatedRenders);
  const productionHistory = matchingEntries(matches.productionHistory);
  const blockers = [];
  if (titleIndex.length > 0) blockers.push("generated title index");
  if (!options.allowCurrentValidatedRender && validatedRenders.length > 0) blockers.push("validated render");
  if (productionHistory.length > 0) blockers.push("production ledger work");
  if (eligibility?.everReleased && !blockers.includes("production ledger work")) {
    blockers.push("released production work");
  }
  if (
    (eligibility?.everPublished?.douyin || eligibility?.everPublished?.xiaohongshu)
    && !blockers.includes("production ledger work")
  ) {
    blockers.push("published production work");
  }
  if (!options.allowCurrentValidatedRender && eligibility?.everGenerated && blockers.length === 0) {
    blockers.push("previously generated work");
  }
  if (!options.allowCurrentValidatedRender && eligibility?.duplicate && blockers.length === 0) {
    blockers.push("duplicate eligibility result");
  }
  if (!options.allowCurrentValidatedRender && eligibility?.eligible === false && blockers.length === 0) {
    blockers.push("ineligible book");
  }
  return blockers;
}

function formatBlockedStockBooks(blocked) {
  return blocked
    .map(({ book, eligibility, blockers }) => `${eligibility?.displayTitle || book} (${blockers.join(", ")})`)
    .join("; ");
}

export function assertBooksEligibleForStockReplenishment(root, books, options = {}) {
  const checked = books.map((book) => ({
    book,
    eligibility: stockEligibility(root, book, options),
  }));
  const blocked = checked
    .map((entry) => ({ ...entry, blockers: stockEligibilityBlockers(entry.eligibility) }))
    .filter((entry) => entry.blockers.length > 0);
  assert(
    blocked.length === 0,
    `Stock replenishment cannot include previously generated books: ${formatBlockedStockBooks(blocked)}`,
  );
  return checked.map((entry) => entry.eligibility);
}

export function assertEpisodeCanFinalizeForReplenishment(root, episodeName, options = {}) {
  const batch = options.batch === undefined ? readReplenishmentBatch(root) : options.batch;
  const item = batch?.items.find((entry) => entry.book === episodeName);
  // A pending in-batch item was checked before it was rendered. Its current validated
  // render is therefore expected and must not be mistaken for a prior production.
  if (batch?.status === "active" && item?.stage === "pending") return batch;

  const eligibility = stockEligibility(root, episodeName, options);
  const blockers = stockEligibilityBlockers(eligibility, { allowCurrentValidatedRender: true });
  assert(
    blockers.length === 0,
    `Stock replenishment cannot finalize an already generated book: ${eligibility?.displayTitle || episodeName} (${blockers.join(", ")})`,
  );
  return batch;
}

function batchPathFor(root) {
  return path.join(root, ".agents", "stock-replenishment.json");
}

function withBatchWriteLock(root, operation) {
  const agentsDir = path.join(root, ".agents");
  const lockPath = path.join(agentsDir, "stock-replenishment.lock");
  fs.mkdirSync(agentsDir, { recursive: true });
  let handle;
  try {
    handle = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Stock replenishment update is already in progress: ${lockPath}`, { cause: error });
    }
    throw error;
  }
  try {
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    return operation();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

export function validateReplenishmentBatch(data, filePath = "stock-replenishment.json") {
  assert(data && typeof data === "object" && !Array.isArray(data), `${filePath}: root must be an object`);
  assert(data.schemaVersion === 1, `${filePath}: schemaVersion must be 1`);
  assert(typeof data.batchId === "string" && data.batchId.trim(), `${filePath}: batchId must be a non-empty string`);
  assert(["active", "complete", "archived"].includes(data.status), `${filePath}: unsupported status ${data.status}`);
  assert(typeof data.startedAt === "string" && data.startedAt.trim(), `${filePath}: startedAt must be a non-empty string`);
  assert(typeof data.sampleBook === "string" && data.sampleBook.trim(), `${filePath}: sampleBook must be a non-empty string`);
  assert(Array.isArray(data.items) && data.items.length > 0, `${filePath}: items must be a non-empty array`);
  assert(data.items[0]?.book === data.sampleBook, `${filePath}: the first item must be the sample book`);
  const books = new Set();
  for (const item of data.items) {
    assert(typeof item?.book === "string" && item.book.trim(), `${filePath}: item.book must be a non-empty string`);
    assert(!books.has(item.book), `${filePath}: duplicate book ${item.book}`);
    books.add(item.book);
    assert(["pending", "publishable"].includes(item.stage), `${filePath}: unsupported stage ${item.stage}`);
    if (item.stage === "publishable") {
      assert(/^[a-f0-9]{64}$/u.test(String(item.renderSha256)), `${filePath}: item.renderSha256 must be a sha256 hex string`);
      assert(/^[a-f0-9]{64}$/u.test(String(item.deliverySha256)), `${filePath}: item.deliverySha256 must be a sha256 hex string`);
      if (item.releaseId !== undefined) {
        assert(/^[a-f0-9]{64}$/u.test(String(item.releaseId)), `${filePath}: item.releaseId must be a sha256 hex string`);
      }
    }
  }
  if (data.status === "complete") {
    assert(data.items.every((item) => item.stage === "publishable"), `${filePath}: complete batch contains pending items`);
    assert(typeof data.completedAt === "string" && data.completedAt.trim(), `${filePath}: completedAt must be a non-empty string`);
  }
  if (data.status === "archived") {
    assert(data.retirement && typeof data.retirement === "object" && !Array.isArray(data.retirement), `${filePath}: archived batch requires retirement metadata`);
    assert(
      data.retirement.kind === "mistaken-stock-replenishment",
      `${filePath}: archived batch retirement kind is invalid`,
    );
    assert(typeof data.retirement.rollbackId === "string" && data.retirement.rollbackId.trim(), `${filePath}: archived batch rollbackId must be non-empty`);
    assert(
      typeof data.retirement.retiredAt === "string" && Number.isFinite(Date.parse(data.retirement.retiredAt)),
      `${filePath}: archived batch retiredAt must be an ISO date`,
    );
    assert(
      typeof data.retirement.recordPath === "string" && data.retirement.recordPath.trim(),
      `${filePath}: archived batch recordPath must be non-empty`,
    );
    assert(
      Array.isArray(data.retirement.archivedQueueReleases) && data.retirement.archivedQueueReleases.length > 0,
      `${filePath}: archived batch must list archived queue releases`,
    );
    const batchReleases = new Map();
    for (const item of data.items.filter((item) => item.releaseId !== undefined)) {
      batchReleases.set(`${item.book}:${item.releaseId}:${item.renderSha256}`, item);
    }
    const retiredReleases = new Set();
    for (const release of data.retirement.archivedQueueReleases) {
      assert(release && typeof release === "object" && !Array.isArray(release), `${filePath}: archived queue release must be an object`);
      assert(typeof release.book === "string" && release.book.trim(), `${filePath}: archived queue release book must be non-empty`);
      assert(/^[a-f0-9]{64}$/u.test(String(release.releaseId)), `${filePath}: archived queue releaseId must be a sha256 hex string`);
      assert(/^[a-f0-9]{64}$/u.test(String(release.renderSha256)), `${filePath}: archived queue renderSha256 must be a sha256 hex string`);
      const key = `${release.book}:${release.releaseId}:${release.renderSha256}`;
      assert(batchReleases.has(key), `${filePath}: archived queue release is not bound to this batch`);
      assert(!retiredReleases.has(key), `${filePath}: duplicate archived queue release ${release.book}`);
      retiredReleases.add(key);
    }
    assert(retiredReleases.size === batchReleases.size, `${filePath}: archived batch did not retire every bound queue release`);
  }
  return data;
}

function writeBatchState(root, state) {
  const filePath = batchPathFor(root);
  validateReplenishmentBatch(state, filePath);
  writeFileAtomically(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8" });
  return readReplenishmentBatch(root, { required: true });
}

export function readReplenishmentBatch(root, options = {}) {
  const filePath = batchPathFor(root);
  if (!fs.existsSync(filePath)) {
    if (options.required) throw new Error(`Missing stock replenishment state: ${filePath}`);
    return null;
  }
  return validateReplenishmentBatch(readJsonFile(filePath), filePath);
}

export function beginReplenishmentBatch(root, books, options = {}) {
  return withBatchWriteLock(root, () => {
    const normalizedBooks = books.map((book) => String(book).trim()).filter(Boolean);
    assert(normalizedBooks.length > 0, "At least one book is required to begin stock replenishment");
    assert(new Set(normalizedBooks).size === normalizedBooks.length, "Stock replenishment book list contains duplicates");
    const existing = readReplenishmentBatch(root);
    if (existing?.status === "active") {
      const existingBooks = existing.items.map((item) => item.book);
      if (JSON.stringify(existingBooks) === JSON.stringify(normalizedBooks)) return existing;
      throw new Error(`Stock replenishment batch ${existing.batchId} is still active`);
    }
    assertBooksEligibleForStockReplenishment(root, normalizedBooks, options);
    const startedAt = options.now instanceof Date
      ? options.now.toISOString()
      : String(options.now || new Date().toISOString());
    return writeBatchState(root, {
      schemaVersion: 1,
      batchId: String(options.batchId || randomUUID()),
      status: "active",
      startedAt,
      sampleBook: normalizedBooks[0],
      items: normalizedBooks.map((book) => ({ book, stage: "pending" })),
    });
  });
}

export function assertEpisodeCanRenderForReplenishment(root, episodeName) {
  const batch = readReplenishmentBatch(root);
  if (!batch || batch.status !== "active") return batch;
  const item = batch.items.find((entry) => entry.book === episodeName);
  if (!item || episodeName === batch.sampleBook) return batch;
  const sample = batch.items[0];
  assert(
    sample.stage === "publishable",
    `Stock replenishment sample gate is closed: finalize ${batch.sampleBook} before rendering ${episodeName}`,
  );
  return batch;
}

export function markReplenishmentEpisodePublishable(root, result, delivery, options = {}) {
  return withBatchWriteLock(root, () => {
    const batch = readReplenishmentBatch(root);
    if (!batch || batch.status !== "active") return batch;
    const itemIndex = batch.items.findIndex((item) => item.book === result.episodeName);
    if (itemIndex === -1) return batch;
    assertEpisodeCanRenderForReplenishment(root, result.episodeName);
    const finalizedAt = options.now instanceof Date
      ? options.now.toISOString()
      : String(options.now || new Date().toISOString());
    const renderSha256 = String(result?.manifest?.output?.sha256 || "").toLowerCase();
    const releaseId = String(result?.queueItem?.releaseId || "").toLowerCase();
    assert(/^[a-f0-9]{64}$/u.test(renderSha256), "Stock replenishment render sha256 is invalid");
    assert(/^[a-f0-9]{64}$/u.test(releaseId), "Stock replenishment requires the finalized immutable releaseId");
    assert(
      String(result.queueItem?.renderSha256 || "").toLowerCase() === renderSha256,
      "Stock replenishment queue render sha256 does not match the finalized render",
    );
    const items = batch.items.map((item, index) => index === itemIndex
      ? {
          ...item,
          stage: "publishable",
          finalizedAt,
          releaseId,
          renderSha256,
          deliverySha256: createHash("sha256").update(delivery, "utf8").digest("hex"),
        }
      : item);
    const complete = items.every((item) => item.stage === "publishable");
    return writeBatchState(root, {
      ...batch,
      status: complete ? "complete" : "active",
      items,
      ...(complete ? { completedAt: finalizedAt } : {}),
    });
  });
}
