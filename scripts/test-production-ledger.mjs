import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createProductionWorkId,
  findProductionWorksByIdentity,
  migrateProductionLedger,
  productionLedgerPath,
  readProductionLedger,
  recordRetractedPublicationProof,
  rebuildProductionLedgerFromLocalState,
  summarizeProductionWork,
  updateProductionLedger,
  validateProductionLedger,
} from "./lib/production-ledger.mjs";

const hash = (character) => character.repeat(64);
const releaseOne = hash("a");
const releaseTwo = hash("b");
const renderOne = hash("c");
const renderTwo = hash("d");
const now = "2026-08-25T03:00:00.000Z";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-production-ledger-test-"));

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function releasePath(book, releaseId) {
  return path.join(root, "episodes", book, "releases", releaseId, "release.json");
}

function renderPath(book, name) {
  return path.join(root, "episodes", book, "renders", `${name}.manifest.json`);
}

function fixtureRelease(book, releaseId, renderSha256) {
  return {
    release: {
      schemaVersion: 1,
      kind: "book-video-release",
      releaseId,
      createdAt: now,
      episode: { name: book, scriptVersion: "v1" },
      video: {
        file: `episodes/${book}/releases/${releaseId}/video.mp4`,
        sha256: renderSha256,
        bytes: 123,
      },
      provenance: {
        renderManifest: { file: `episodes/${book}/renders/final.manifest.json` },
      },
    },
    videoPath: path.join(root, "episodes", book, "releases", releaseId, "video.mp4"),
  };
}

function fixtureRender(book, renderSha256) {
  return {
    manifest: {
      schemaVersion: 1,
      kind: "book-video-render",
      createdAt: now,
      episode: { name: book, scriptVersion: "v1" },
      output: {
        file: `episodes/${book}/renders/final.mp4`,
        sha256: renderSha256,
        bytes: 123,
      },
    },
  };
}

try {
  assert.notEqual(
    createProductionWorkId("《同名书》", "作者甲"),
    createProductionWorkId("同名书", "作者乙"),
    "workId must include normalized author",
  );
  assert.notEqual(
    createProductionWorkId("同名书", ""),
    createProductionWorkId("同名书", "作者甲"),
    "unknown author must not merge into a known-author work",
  );

  writeJson(path.join(root, "episodes", "同名书", "brief.json"), {
    display_title: "同名书",
    author: "作者甲",
  });
  writeJson(releasePath("同名书", releaseOne), { fixture: true });
  writeJson(path.join(path.dirname(releasePath("同名书", releaseOne)), "READY"), { fixture: true });
  writeJson(renderPath("同名书", "final"), { fixture: true });

  writeJson(path.join(root, "episodes", "手工书", "brief.json"), {
    display_title: "手工书",
    author: "",
  });
  writeJson(releasePath("手工书", releaseTwo), { fixture: true });
  writeJson(path.join(path.dirname(releasePath("手工书", releaseTwo)), "READY"), { fixture: true });
  writeJson(renderPath("手工书", "final"), { fixture: true });

  writeJson(path.join(root, ".agents", "publish-queue.json"), {
    updatedAt: now,
    items: [
      {
        position: 1,
        book: "同名书",
        renderSha256: renderOne,
        releaseId: releaseOne,
        createdAt: now,
        douyinStatus: "published",
        xiaohongshuStatus: "published",
        douyinPublication: {
          platform: "douyin",
          releaseId: releaseOne,
          renderSha256: renderOne,
          verifiedAt: now,
          signal: "official list contains exact title",
          url: "https://creator.douyin.com/creator-micro/content/manage",
          screenshotPath: path.join(root, "proof.png"),
        },
        previousReleases: [
          {
            releaseId: releaseTwo,
            renderSha256: renderTwo,
            createdAt: now,
            douyinStatus: "published",
            xiaohongshuStatus: "pending",
          },
        ],
      },
    ],
  });
  writeJson(path.join(root, ".agents", "publish-queue.archive.json"), {
    updatedAt: now,
    items: [
      {
        archivedAt: now,
        reason: "fixture",
        item: {
          position: 2,
          book: "手工书",
          renderSha256: renderTwo,
          releaseId: releaseTwo,
          createdAt: now,
          douyinStatus: "pending",
          xiaohongshuStatus: "pending",
        },
      },
    ],
  });
  writeJson(path.join(root, ".agents", "browser-publisher", "sessions", "session-published.json"), {
    schemaVersion: 1,
    id: "session-published",
    createdAt: now,
    updatedAt: now,
    requestedPlatforms: ["douyin", "xiaohongshu"],
    attempts: { douyin: 2, xiaohongshu: 1 },
    accounts: { douyin: { name: "账号", id: "1" }, xiaohongshu: { name: "小红书", id: "2" } },
    brief: { releaseId: releaseTwo, renderSha256: renderTwo, queuePosition: 2 },
    platforms: {
      douyin: {
        status: "published",
        updatedAt: now,
        proof: {
          url: "https://creator.douyin.com/creator-micro/content/manage",
          signal: "session says published",
          verifiedAt: now,
        },
      },
      xiaohongshu: {
        status: "published",
        updatedAt: now,
        proof: {
          url: "https://creator.xiaohongshu.com/new/note-manager",
          signal: "session says published",
          verifiedAt: now,
        },
      },
    },
  });
  writeJson(path.join(root, ".agents", "manual-publisher", "xiaohongshu", `${releaseTwo}.json`), {
    schemaVersion: 1,
    platform: "xiaohongshu",
    releaseId: releaseTwo,
    renderSha256: renderTwo,
    queuePosition: 2,
    launchedAt: now,
  });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "generated-book-titles.txt"), "索引孤儿书\n同名书\n", "utf8");

  const releaseFixtures = new Map([
    [releasePath("同名书", releaseOne), fixtureRelease("同名书", releaseOne, renderOne)],
    [releasePath("手工书", releaseTwo), fixtureRelease("手工书", releaseTwo, renderTwo)],
  ]);
  const renderFixtures = new Map([
    [renderPath("同名书", "final"), fixtureRender("同名书", renderOne)],
    [renderPath("手工书", "final"), fixtureRender("手工书", renderTwo)],
  ]);
  const readers = {
    now,
    verifyMedia: false,
    releaseReader: (filePath) => {
      const result = releaseFixtures.get(filePath);
      if (!result) throw new Error(`unexpected release ${filePath}`);
      return result;
    },
    renderReader: (filePath) => {
      const result = renderFixtures.get(filePath);
      if (!result) throw new Error(`unexpected render ${filePath}`);
      return result;
    },
  };
  const rebuilt = rebuildProductionLedgerFromLocalState(root, readers);
  assert.equal(rebuilt.sourceCounts.validReleases, 2);
  assert.equal(rebuilt.sourceCounts.validRenders, 2);
  assert.equal(rebuilt.sourceCounts.sessionAttempts, 2);
  assert.equal(rebuilt.sourceCounts.manualXiaohongshuAttempts, 1);
  assert.equal(Object.keys(rebuilt.ledger.releases).length, 2, "releaseId is the release primary key");
  validateProductionLedger(rebuilt.ledger);

  const knownWork = findProductionWorksByIdentity(rebuilt.ledger, "同名书", "作者甲");
  assert.equal(knownWork.length, 1);
  assert.equal(knownWork[0].everGenerated, true);
  assert.equal(knownWork[0].everReleased, true);
  assert.equal(knownWork[0].platforms.douyin.everPublished, true, "queue proof establishes Douyin publication");
  assert.equal(knownWork[0].platforms.xiaohongshu.everPublished, false, "published queue status alone is not proof");
  assert.equal(knownWork[0].platforms.xiaohongshu.evidenceState, "unverified");
  assert.equal(knownWork[0].platforms.xiaohongshu.trackingMode, "follow_douyin");
  assert.equal(knownWork[0].platforms.xiaohongshu.operationallyComplete, true);
  const retractedLedger = structuredClone(rebuilt.ledger);
  recordRetractedPublicationProof(retractedLedger, {
    releaseId: releaseOne,
    platform: "douyin",
    proof: retractedLedger.releases[releaseOne].platforms.douyin.proofs[0],
    retractedAt: "2026-08-25T03:00:30.000Z",
    reason: "fixture false positive",
  });
  assert.equal(
    summarizeProductionWork(retractedLedger, knownWork[0].workId).platforms.douyin.everPublished,
    false,
    "a retracted proof must not remain published after merge or rebuild",
  );

  const manualWork = findProductionWorksByIdentity(rebuilt.ledger, "手工书", "");
  assert.equal(manualWork.length, 1);
  assert.equal(manualWork[0].platforms.douyin.everPublished, false, "session proof must not auto-upgrade publication");
  assert.equal(manualWork[0].platforms.xiaohongshu.everPublished, false, "manual Xiaohongshu session remains unverified without queue proof");
  assert.equal(manualWork[0].platforms.xiaohongshu.evidenceState, "unverified");
  assert.equal(manualWork[0].platforms.xiaohongshu.operationallyComplete, false, "Xiaohongshu completion follows Douyin proof");
  assert.equal(rebuilt.ledger.releases[releaseTwo].platforms.douyin.attempts.length, 1);
  assert.equal(rebuilt.ledger.releases[releaseTwo].platforms.xiaohongshu.attempts.length, 2);

  const indexOnly = findProductionWorksByIdentity(rebuilt.ledger, "索引孤儿书", "");
  assert.equal(indexOnly.length, 1);
  assert.equal(indexOnly[0].legacyGeneratedIndexClaim, true);
  assert.equal(indexOnly[0].everGenerated, false, "legacy index is preserved but not treated as a validated render");

  const migrated = migrateProductionLedger(root, readers);
  assert.equal(migrated.wrote, true);
  assert.equal(fs.existsSync(productionLedgerPath(root)), true);
  assert.equal(fs.existsSync(`${productionLedgerPath(root)}.${process.pid}.tmp`), false, "ledger writes atomically");
  const persisted = readProductionLedger(root, { required: true });
  assert.equal(summarizeProductionWork(persisted, knownWork[0].workId).platforms.douyin.everPublished, true);
  const migratedAgain = migrateProductionLedger(root, readers);
  assert.equal(migratedAgain.wrote, true);
  assert.equal(Object.keys(migratedAgain.ledger.releases).length, 2, "rerunning migration must merge, not duplicate releases");
  assert.equal(
    migratedAgain.ledger.releases[releaseTwo].platforms.xiaohongshu.attempts.length,
    2,
    "rerunning migration must deduplicate recorded attempts",
  );

  const updated = updateProductionLedger(root, (ledger) => ledger, { now: "2026-08-25T03:01:00.000Z" });
  assert.equal(updated.updatedAt, "2026-08-25T03:01:00.000Z");
  assert.equal(fs.existsSync(path.join(root, ".agents", "production-ledger.lock")), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("production ledger: ok");
