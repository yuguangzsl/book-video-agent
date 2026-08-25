import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBookEligibility, recordGeneratedTitle } from "../lib/generated-title-index.mjs";
import {
  createProductionLedger,
  ensureProductionWork,
  writeProductionLedger,
} from "../lib/production-ledger.mjs";
import {
  assertEpisodeCanFinalizeForReplenishment,
  assertEpisodeCanRenderForReplenishment,
  beginReplenishmentBatch,
  markReplenishmentEpisodePublishable,
  readReplenishmentBatch,
} from "../lib/replenishment-batch.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-replenishment-test-"));
const books = ["样本书", "第二本", "第三本"];

function result(book, digit) {
  const renderSha256 = digit.repeat(64);
  return {
    episodeName: book,
    manifest: { output: { sha256: renderSha256 } },
    queueItem: {
      releaseId: String.fromCharCode(digit.charCodeAt(0) + 3).repeat(64),
      renderSha256,
    },
  };
}

try {
  const batch = beginReplenishmentBatch(root, books, {
    batchId: "batch-test",
    now: new Date("2026-07-27T01:00:00.000Z"),
  });
  assert.equal(batch.sampleBook, "样本书");
  // An in-progress batch is a retryable transaction. Once the sample is finalized,
  // it is deliberately present in the generated-title index, so the matching batch
  // must be returned before the new-batch duplicate preflight runs.
  recordGeneratedTitle(root, books[0]);
  assert.equal(beginReplenishmentBatch(root, books).batchId, "batch-test");
  assert.doesNotThrow(() => assertEpisodeCanRenderForReplenishment(root, "样本书"));
  assert.throws(
    () => assertEpisodeCanRenderForReplenishment(root, "第二本"),
    /sample gate is closed/,
  );

  markReplenishmentEpisodePublishable(root, result("样本书", "a"), "样本交付", {
    now: new Date("2026-07-27T02:00:00.000Z"),
  });
  assert.doesNotThrow(() => assertEpisodeCanRenderForReplenishment(root, "第二本"));
  markReplenishmentEpisodePublishable(root, result("第二本", "b"), "第二本交付", {
    now: new Date("2026-07-27T03:00:00.000Z"),
  });
  markReplenishmentEpisodePublishable(root, result("第三本", "c"), "第三本交付", {
    now: new Date("2026-07-27T04:00:00.000Z"),
  });
  const completed = readReplenishmentBatch(root, { required: true });
  assert.equal(completed.status, "complete");
  assert.equal(completed.items.every((item) => item.stage === "publishable"), true);
  assert.match(completed.items[0].releaseId, /^[a-f0-9]{64}$/u);
  assert.match(completed.items[0].deliverySha256, /^[a-f0-9]{64}$/u);
  assert.equal(fs.existsSync(path.join(root, ".agents", "stock-replenishment.lock")), false);

  const tombstoneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-replenishment-tombstone-test-"));
  try {
    recordGeneratedTitle(tombstoneRoot, "《标题墓碑》");
    assert.throws(
      () => beginReplenishmentBatch(tombstoneRoot, ["标题墓碑"], { batchId: "tombstone-batch" }),
      /generated title index/u,
    );
    assert.equal(readReplenishmentBatch(tombstoneRoot), null);
    assert.throws(
      () => assertEpisodeCanFinalizeForReplenishment(tombstoneRoot, "标题墓碑"),
      /already generated book: 标题墓碑 \(generated title index\)/u,
    );
  } finally {
    fs.rmSync(tombstoneRoot, { recursive: true, force: true });
  }

  const renderedTitle = "已有有效渲染";
  const renderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-replenishment-render-test-"));
  try {
    const rendersDir = path.join(renderRoot, "episodes", renderedTitle, "renders");
    fs.mkdirSync(rendersDir, { recursive: true });
    fs.writeFileSync(path.join(rendersDir, "final.manifest.json"), "{}\n");
    const checkedBooks = [];
    const checkFixtureEligibility = (targetRoot, book, options) => {
      checkedBooks.push({ book, maintenance: options.maintenance });
      return checkBookEligibility(targetRoot, book, {
        ...options,
        manifestReader: () => ({ manifest: { episode: { name: renderedTitle } } }),
      });
    };
    assert.throws(
      () => beginReplenishmentBatch(renderRoot, [renderedTitle, "仍需检查的新书"], {
        batchId: "rendered-batch",
        checkBookEligibility: checkFixtureEligibility,
        eligibilityOptions: { maintenance: true },
      }),
      /validated render/u,
    );
    assert.deepEqual(checkedBooks, [
      { book: renderedTitle, maintenance: false },
      { book: "仍需检查的新书", maintenance: false },
    ]);
    assert.equal(readReplenishmentBatch(renderRoot), null);
    // A fresh episode reaches finalization only after it has produced its own
    // validated render, so this evidence alone must remain finalizable.
    assert.doesNotThrow(() => assertEpisodeCanFinalizeForReplenishment(renderRoot, renderedTitle, {
      checkBookEligibility: checkFixtureEligibility,
    }));
  } finally {
    fs.rmSync(renderRoot, { recursive: true, force: true });
  }

  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-replenishment-ledger-test-"));
  try {
    const now = new Date("2026-08-25T03:00:00.000Z");
    const ledger = createProductionLedger({ now });
    ensureProductionWork(ledger, { displayTitle: "台账已有工作" }, { now });
    writeProductionLedger(ledgerRoot, ledger, { now });
    assert.throws(
      () => beginReplenishmentBatch(ledgerRoot, ["台账已有工作"], { batchId: "ledger-batch" }),
      /production ledger work/u,
    );
    assert.equal(readReplenishmentBatch(ledgerRoot), null);
    assert.throws(
      () => assertEpisodeCanFinalizeForReplenishment(ledgerRoot, "台账已有工作"),
      /production ledger work/u,
    );
  } finally {
    fs.rmSync(ledgerRoot, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("replenishment batch: ok");
