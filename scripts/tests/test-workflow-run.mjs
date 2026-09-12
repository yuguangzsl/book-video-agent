import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProductionLedger, writeProductionLedger } from "../lib/production-ledger.mjs";
import { beginReplenishmentBatch } from "../lib/replenishment-batch.mjs";
import {
  appendWorkflowAction,
  completeWorkflowAction,
  createWorkflowRun,
  replenishmentDecision,
  retryWorkflowActionState,
  startReplenishmentWorkflow,
  validateWorkflowRun,
} from "../lib/workflow-run.mjs";

assert.deepEqual(replenishmentDecision(2), { action: "replenish", pendingCount: 2, needed: 5 });
assert.deepEqual(replenishmentDecision(3), { action: "replenish", pendingCount: 3, needed: 4 });
assert.deepEqual(replenishmentDecision(6), { action: "replenish", pendingCount: 6, needed: 1 });
assert.deepEqual(replenishmentDecision(7), { action: "no_action", pendingCount: 7, needed: 0 });
assert.deepEqual(replenishmentDecision(8), { action: "no_action", pendingCount: 8, needed: 0 });
assert.deepEqual(replenishmentDecision(0), { action: "replenish", pendingCount: 0, needed: 7 });

const run = createWorkflowRun("replenish", { needed: 1 });
const action = appendWorkflowAction(run, "refresh_candidates", { works: ["书甲"] }, { maxAttempts: 3 });
validateWorkflowRun(run);
assert.match(run.inputHash, /^[a-f0-9]{64}$/u);
assert.match(action.payloadHash, /^[a-f0-9]{64}$/u);
assert.equal(action.attempts, 0);
assert.throws(() => completeWorkflowAction(run, "wrong-id"), /Action id mismatch/u);
completeWorkflowAction(run, action.id, { refreshed: 1 });
assert.equal(action.status, "completed");
assert.throws(() => completeWorkflowAction(run, action.id), /no pending action/u);
const tampered = structuredClone(run);
tampered.actions[0].payload.works.push("书乙");
assert.throws(() => validateWorkflowRun(tampered), /action identity changed/u);
const tamperedInput = structuredClone(run);
tamperedInput.input.needed = 2;
assert.throws(() => validateWorkflowRun(tamperedInput), /workflow input identity changed/u);

function failedEpisodeRun(errorClass, attempts = 1, maxAttempts = 3) {
  const workflow = createWorkflowRun("replenish", { needed: 1, target: 7 });
  const action = appendWorkflowAction(workflow, "produce_episode", {
    book: "书甲",
    index: 1,
    total: 1,
  }, { maxAttempts });
  action.status = "failed";
  action.attempts = attempts;
  action.lastError = { class: errorClass, message: "temporary failure", at: new Date().toISOString() };
  workflow.status = "blocked";
  workflow.stage = "blocked";
  workflow.blocker = { code: errorClass, actionId: action.id };
  validateWorkflowRun(workflow);
  return { workflow, action };
}

const retryable = failedEpisodeRun("transient_tts");
const retryableActionId = retryable.action.id;
const retryablePayloadHash = retryable.action.payloadHash;
const retryableInputHash = retryable.workflow.inputHash;
retryWorkflowActionState(retryable.workflow, { actionId: retryableActionId });
assert.equal(retryable.workflow.status, "waiting");
assert.equal(retryable.workflow.stage, "produce_episode");
assert.equal(retryable.workflow.blocker, undefined);
assert.equal(retryable.action.status, "pending");
assert.equal(retryable.action.attempts, 1);
assert.equal(retryable.action.id, retryableActionId);
assert.equal(retryable.action.payloadHash, retryablePayloadHash);
assert.equal(retryable.workflow.inputHash, retryableInputHash);

const reclassified = failedEpisodeRun("unknown");
retryWorkflowActionState(reclassified.workflow, {
  actionId: reclassified.action.id,
  errorClass: "transient_tts",
  reason: "Edge TTS timeout was recorded with the wrong class",
});
assert.equal(reclassified.action.lastError.class, "transient_tts");
assert.deepEqual(reclassified.action.errorReclassifications[0].from, "unknown");
assert.deepEqual(reclassified.action.errorReclassifications[0].to, "transient_tts");
assert.equal(reclassified.action.errorReclassifications[0].reason, "Edge TTS timeout was recorded with the wrong class");

const unexplainedUnknown = failedEpisodeRun("unknown");
assert.throws(
  () => retryWorkflowActionState(unexplainedUnknown.workflow, {
    actionId: unexplainedUnknown.action.id,
    errorClass: "transient_tts",
  }),
  /non-empty retry reason/u,
);

const wrongId = failedEpisodeRun("transient_tts");
assert.throws(
  () => retryWorkflowActionState(wrongId.workflow, { actionId: "wrong-id" }),
  /Action id mismatch/u,
);

const nonRetryable = failedEpisodeRun("validation_failure");
assert.throws(
  () => retryWorkflowActionState(nonRetryable.workflow, {
    actionId: nonRetryable.action.id,
    errorClass: "transient_tts",
    reason: "must not bypass validation",
  }),
  /not retryable/u,
);

const exhausted = failedEpisodeRun("transient_tts", 3, 3);
assert.throws(
  () => retryWorkflowActionState(exhausted.workflow, { actionId: exhausted.action.id }),
  /retry limit reached/u,
);

function createWorkflowRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-workflow-run-test-"));
  const now = new Date("2026-09-09T01:00:00.000Z");
  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  writeProductionLedger(root, createProductionLedger({ now }), { now });
  fs.writeFileSync(path.join(root, ".agents", "publish-queue.json"), `${JSON.stringify({
    schemaVersion: 2,
    updatedAt: now.toISOString(),
    items: [],
  }, null, 2)}\n`, "utf8");
  return root;
}

function writeWorkflowRunFixture(root, workflow) {
  const runsDir = path.join(root, ".agents", "workflow-runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, `${workflow.id}.json`), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runsDir, "current-replenish.json"), `${JSON.stringify({ runId: workflow.id }, null, 2)}\n`, "utf8");
}

function createWaitingProductionRun(root, books = ["恢复书甲", "恢复书乙"], actionOptions = {}) {
  const batch = beginReplenishmentBatch(root, books, { batchId: "workflow-recovery-batch" });
  const workflow = createWorkflowRun("replenish", {
    pendingCount: 0,
    needed: books.length,
    threshold: 3,
    target: 7,
  });
  workflow.batchId = batch.batchId;
  workflow.books = [...books];
  const action = appendWorkflowAction(workflow, "produce_episode", {
    book: actionOptions.book || books[0],
    index: actionOptions.index || 1,
    total: books.length,
  }, { maxAttempts: 3 });
  writeWorkflowRunFixture(root, workflow);
  return { workflow, action, batch };
}

function withWorkflowRoot(callback) {
  const root = createWorkflowRoot();
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

withWorkflowRoot((root) => {
  const { workflow, action } = createWaitingProductionRun(root);
  const runPath = path.join(root, ".agents", "workflow-runs", `${workflow.id}.json`);
  const batchPath = path.join(root, ".agents", "stock-replenishment.json");
  const runBefore = fs.readFileSync(runPath, "utf8");
  const batchBefore = fs.readFileSync(batchPath, "utf8");
  const resumed = startReplenishmentWorkflow(root);
  assert.equal(resumed.id, workflow.id);
  assert.equal(resumed.currentActionId, action.id);
  assert.equal(resumed.actions.at(-1).id, action.id);
  assert.equal(fs.readFileSync(runPath, "utf8"), runBefore);
  assert.equal(fs.readFileSync(batchPath, "utf8"), batchBefore);
  assert.equal(startReplenishmentWorkflow(root, { dryRun: true }).currentActionId, action.id);
  assert.equal(fs.readFileSync(runPath, "utf8"), runBefore);
});

withWorkflowRoot((root) => {
  const { workflow } = createWaitingProductionRun(root);
  workflow.books.reverse();
  writeWorkflowRunFixture(root, workflow);
  assert.throws(() => startReplenishmentWorkflow(root), /book order changed/u);
});

withWorkflowRoot((root) => {
  const { workflow } = createWaitingProductionRun(root);
  workflow.batchId = "wrong-batch";
  writeWorkflowRunFixture(root, workflow);
  assert.throws(() => startReplenishmentWorkflow(root), /batch identity changed/u);
});

withWorkflowRoot((root) => {
  createWaitingProductionRun(root, ["恢复书甲", "恢复书乙"], { book: "恢复书乙", index: 2 });
  assert.throws(() => startReplenishmentWorkflow(root), /not the current replenishment batch item/u);
});

withWorkflowRoot((root) => {
  const batch = beginReplenishmentBatch(root, ["孤儿批次书"], { batchId: "legacy-batch" });
  const result = startReplenishmentWorkflow(root);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "legacy_active_batch");
  assert.equal(result.batchId, batch.batchId);
});

withWorkflowRoot((root) => {
  const { workflow, action } = createWaitingProductionRun(root);
  action.status = "failed";
  action.attempts = 1;
  action.lastError = { class: "validation_failure", message: "blocked for review", at: new Date().toISOString() };
  workflow.status = "blocked";
  workflow.stage = "blocked";
  workflow.blocker = { code: "validation_failure", actionId: action.id };
  writeWorkflowRunFixture(root, workflow);
  const blocked = startReplenishmentWorkflow(root);
  assert.equal(blocked.id, workflow.id);
  assert.equal(blocked.status, "blocked");
});

withWorkflowRoot((root) => {
  const workflow = createWorkflowRun("replenish", { pendingCount: 0, needed: 2, threshold: 3, target: 7 });
  const action = appendWorkflowAction(workflow, "refresh_candidates", { round: 1, works: [] }, { maxAttempts: 3 });
  writeWorkflowRunFixture(root, workflow);
  const resumed = startReplenishmentWorkflow(root, { dryRun: true });
  assert.equal(resumed.id, workflow.id);
  assert.equal(resumed.currentActionId, action.id);
  assert.equal(fs.existsSync(path.join(root, ".agents", "stock-replenishment.json")), false);
});
