import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./filesystem.mjs";
import { readJsonFile } from "./json.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function validateBatchState(data, filePath = "stock-replenishment.json") {
  assert(data && typeof data === "object" && !Array.isArray(data), `${filePath}: root must be an object`);
  assert(data.schemaVersion === 1, `${filePath}: schemaVersion must be 1`);
  assert(typeof data.batchId === "string" && data.batchId.trim(), `${filePath}: batchId must be a non-empty string`);
  assert(["active", "complete"].includes(data.status), `${filePath}: unsupported status ${data.status}`);
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
  }
  if (data.status === "complete") {
    assert(data.items.every((item) => item.stage === "publishable"), `${filePath}: complete batch contains pending items`);
    assert(typeof data.completedAt === "string" && data.completedAt.trim(), `${filePath}: completedAt must be a non-empty string`);
  }
  return data;
}

function writeBatchState(root, state) {
  const filePath = batchPathFor(root);
  validateBatchState(state, filePath);
  writeFileAtomically(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8" });
  return readReplenishmentBatch(root, { required: true });
}

export function readReplenishmentBatch(root, options = {}) {
  const filePath = batchPathFor(root);
  if (!fs.existsSync(filePath)) {
    if (options.required) throw new Error(`Missing stock replenishment state: ${filePath}`);
    return null;
  }
  return validateBatchState(readJsonFile(filePath), filePath);
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
    const items = batch.items.map((item, index) => index === itemIndex
      ? {
          ...item,
          stage: "publishable",
          finalizedAt,
          renderSha256: result.manifest.output.sha256.toLowerCase(),
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
