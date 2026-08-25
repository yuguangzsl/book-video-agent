#!/usr/bin/env node

import {
  findProductionWorksByIdentity,
  readProductionLedger,
  rebuildProductionLedgerFromLocalState,
  summarizeProductionWork,
  verifyPublishQueueProjection,
} from "./lib/production-ledger.mjs";
import {
  readPublishQueue,
  selectNextDouyinPublishQueueItem,
} from "./lib/publish-queue.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const verify = args.includes("--verify");
const next = args.includes("--next");
const bookIndex = args.indexOf("--book");
const book = bookIndex >= 0 ? String(args[bookIndex + 1] || "").trim() : "";
const allowed = new Set(["--verify", "--next", "--book"]);

for (const [index, arg] of args.entries()) {
  if (bookIndex >= 0 && index === bookIndex + 1) continue;
  if (!allowed.has(arg)) {
    throw new Error("Usage: node scripts/inspect-production-state.mjs [--verify | --next | --book <display-title>]");
  }
}
if ([verify, next, Boolean(book)].filter(Boolean).length > 1) {
  throw new Error("Use only one of --verify, --next, or --book");
}
if (bookIndex >= 0 && !book) throw new Error("--book requires a display title");

if (next) {
  process.stdout.write(`${JSON.stringify(selectNextDouyinPublishQueueItem(ROOT), null, 2)}\n`);
} else if (verify) {
  const queue = readPublishQueue(ROOT, { required: true });
  const persisted = readProductionLedger(ROOT, { required: true });
  const persistedReleases = verifyPublishQueueProjection(persisted, queue.items);
  const rebuilt = rebuildProductionLedgerFromLocalState(ROOT);
  const rebuiltReleases = verifyPublishQueueProjection(rebuilt.ledger, queue.items);
  process.stdout.write(`${JSON.stringify({
    verifiedAt: new Date().toISOString(),
    ledgerWorks: Object.keys(persisted.works).length,
    ledgerRenders: Object.keys(persisted.renders).length,
    ledgerReleases: Object.keys(persisted.releases).length,
    queueItems: queue.items.length,
    queueReleaseIds: persistedReleases.map((release) => release.releaseId),
    rebuiltReleaseIds: rebuiltReleases.map((release) => release.releaseId),
    unresolvedReferences: rebuilt.ledger.unresolvedReferences.length,
    warnings: rebuilt.warnings,
  }, null, 2)}\n`);
} else {
  const ledger = readProductionLedger(ROOT, { required: true });
  const works = book
    ? findProductionWorksByIdentity(ledger, book)
    : Object.keys(ledger.works)
      .map((workId) => summarizeProductionWork(ledger, workId))
      .sort((left, right) => left.displayTitle.localeCompare(right.displayTitle, "zh-CN"));
  process.stdout.write(`${JSON.stringify({
    updatedAt: ledger.updatedAt,
    count: works.length,
    works,
  }, null, 2)}\n`);
}
