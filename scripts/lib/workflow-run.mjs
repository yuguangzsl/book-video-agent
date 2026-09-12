import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readCsvFile } from "./csv.mjs";
import { candidateRefreshPlan, rankCanonicalCandidates, signalsAreFresh } from "./candidate-ranking.mjs";
import { checkBookEligibility } from "./generated-title-index.mjs";
import { writeFileAtomically } from "./filesystem.mjs";
import { readJsonFile } from "./json.mjs";
import { readPublishQueue } from "./publish-queue.mjs";
import { readProductionLedger, summarizeProductionRelease, verifyPublishQueueProjection } from "./production-ledger.mjs";
import {
  beginReplenishmentBatch,
  readReplenishmentBatch,
  replacePendingReplenishmentBook,
} from "./replenishment-batch.mjs";
import { validateCompletedEpisode } from "./episode-checks.mjs";
import { validateEpisodeQa } from "./episode-qa.mjs";

export const WORKFLOW_RUN_SCHEMA_VERSION = 1;
export const REPLENISH_TARGET = 7;
export const REPLENISH_THRESHOLD = REPLENISH_TARGET;
export const WORKFLOW_ERROR_CLASSES = new Set([
  "transient_tts",
  "transient_hyperframes",
  "qa_failure",
  "definite_publish_failure",
  "identity_mismatch",
  "validation_failure",
  "authentication_required",
  "captcha_required",
  "unknown",
]);

const MODES = new Set(["replenish", "publish-next"]);
const TERMINAL_STATUSES = new Set(["completed", "blocked", "no_action"]);
const NON_RETRYABLE_ERRORS = new Set([
  "identity_mismatch",
  "validation_failure",
  "authentication_required",
  "captcha_required",
  "unknown",
]);
const RETRYABLE_REPLENISHMENT_ERRORS = new Set([
  "transient_tts",
  "transient_hyperframes",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runsRoot(root) {
  return path.join(root, ".agents", "workflow-runs");
}

function runPath(root, runId) {
  return path.join(runsRoot(root), `${runId}.json`);
}

function pointerPath(root, mode) {
  return path.join(runsRoot(root), `current-${mode}.json`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function actionId(run, kind, payload, sequence) {
  return crypto.createHash("sha256")
    .update(stableJson({ runId: run.id, mode: run.mode, sequence, kind, payload }))
    .digest("hex");
}

function writeRun(root, run) {
  run.updatedAt = new Date().toISOString();
  validateWorkflowRun(run);
  fs.mkdirSync(runsRoot(root), { recursive: true });
  writeFileAtomically(runPath(root, run.id), `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8" });
  writeFileAtomically(pointerPath(root, run.mode), `${JSON.stringify({ runId: run.id }, null, 2)}\n`, { encoding: "utf8" });
  return run;
}

export function appendWorkflowAction(run, kind, payload, options = {}) {
  const sequence = run.actions.length + 1;
  const action = {
    id: actionId(run, kind, payload, sequence),
    payloadHash: contentHash(payload),
    sequence,
    kind,
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
    maxAttempts: Number(options.maxAttempts || 1),
    payload,
  };
  run.actions.push(action);
  run.currentActionId = action.id;
  run.stage = kind;
  run.status = "waiting";
  return action;
}

function currentAction(run) {
  return run.actions.find((action) => action.id === run.currentActionId) || null;
}

export function validateWorkflowRun(run, filePath = "workflow-run.json") {
  assert(run && typeof run === "object" && !Array.isArray(run), `${filePath}: run must be an object`);
  assert(run.schemaVersion === WORKFLOW_RUN_SCHEMA_VERSION, `${filePath}: unsupported schemaVersion`);
  assert(typeof run.id === "string" && run.id.trim(), `${filePath}: id must be non-empty`);
  assert(MODES.has(run.mode), `${filePath}: unsupported mode ${run.mode}`);
  assert(["running", "waiting", ...TERMINAL_STATUSES].includes(run.status), `${filePath}: unsupported status ${run.status}`);
  assert(Array.isArray(run.actions), `${filePath}: actions must be an array`);
  assert(run.inputHash === contentHash(run.input), `${filePath}: workflow input identity changed`);
  const actionIds = new Set();
  for (const action of run.actions) {
    assert(!actionIds.has(action.id), `${filePath}: duplicate action id ${action.id}`);
    actionIds.add(action.id);
    assert(action.id === actionId(run, action.kind, action.payload, action.sequence), `${filePath}: action identity changed`);
    assert(action.payloadHash === contentHash(action.payload), `${filePath}: action payload hash changed`);
    assert(["pending", "completed", "failed"].includes(action.status), `${filePath}: invalid action status`);
    assert(Number.isInteger(action.maxAttempts) && action.maxAttempts >= 1, `${filePath}: invalid maxAttempts`);
    assert(Number.isInteger(action.attempts || 0) && (action.attempts || 0) <= action.maxAttempts, `${filePath}: invalid attempts`);
  }
  if (run.status === "waiting") {
    const active = currentAction(run);
    assert(active?.status === "pending", `${filePath}: waiting run requires one pending current action`);
  }
  return run;
}

export function readWorkflowRun(root, options = {}) {
  let runId = String(options.runId || "").trim();
  if (!runId) {
    const mode = String(options.mode || "").trim();
    assert(MODES.has(mode), "Workflow mode is required when runId is omitted");
    const pointer = pointerPath(root, mode);
    if (!fs.existsSync(pointer)) return null;
    runId = String(readJsonFile(pointer).runId || "").trim();
  }
  const filePath = runPath(root, runId);
  if (!fs.existsSync(filePath)) return null;
  return validateWorkflowRun(readJsonFile(filePath), filePath);
}

function verifiedPendingInventory(root) {
  const queue = readPublishQueue(root, { required: true });
  const ledger = readProductionLedger(root, { required: true });
  verifyPublishQueueProjection(ledger, queue.items);
  const pending = [];
  for (const item of queue.items.filter((entry) => entry.douyinStatus === "pending")) {
    validateCompletedEpisode(root, item.book, item.scriptVersion, { requirePublish: true, requireQueue: true });
    pending.push(item);
  }
  return { queue, ledger, pending };
}

export function createWorkflowRun(mode, input = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    mode,
    status: "running",
    createdAt: now,
    updatedAt: now,
    input,
    inputHash: contentHash(input),
    stage: "starting",
    actions: [],
    currentActionId: null,
  };
}

export function replenishmentDecision(pendingCount) {
  const count = Number(pendingCount);
  assert(Number.isInteger(count) && count >= 0, "pendingCount must be a non-negative integer");
  return count >= REPLENISH_THRESHOLD
    ? { action: "no_action", pendingCount: count, needed: 0 }
    : { action: "replenish", pendingCount: count, needed: REPLENISH_TARGET - count };
}

function chooseEligibleBooks(root, rows, needed) {
  const selected = [];
  const rejected = [];
  for (const candidate of rankCanonicalCandidates(rows)) {
    if (!signalsAreFresh(candidate)) continue;
    const title = String(candidate.display_title || "").trim();
    const eligibility = checkBookEligibility(root, title, { maintenance: false });
    if (eligibility.eligible) selected.push({ title, author: candidate.author, heatScore: candidate.heat_score });
    else rejected.push({ title, reason: "duplicate_or_previously_generated" });
    if (selected.length === needed) break;
  }
  return { selected, rejected };
}

function chooseReplacementBook(root, rows, excludedBooks) {
  const excluded = new Set(excludedBooks);
  for (const candidate of rankCanonicalCandidates(rows)) {
    if (!signalsAreFresh(candidate)) continue;
    const title = String(candidate.display_title || "").trim();
    if (!title || excluded.has(title)) continue;
    if (checkBookEligibility(root, title, { maintenance: false }).eligible) {
      return { title, author: candidate.author, heatScore: candidate.heat_score };
    }
  }
  return null;
}

function productionAction(run, book, index, total) {
  return appendWorkflowAction(run, "produce_episode", {
    book,
    index,
    total,
    humanApprovalRequired: false,
    qa: { required: true, localReworkLimit: 2 },
    requiredSequence: [
      "validate-script",
      "prepare-voiceover",
      "pre-render-check",
      "render-final",
      "prepare-episode-qa",
      "codex-vision-and-independent-asr-review",
      "complete-episode-qa",
      "stock-finalize",
    ],
  }, { maxAttempts: 3 });
}

function candidateRefreshAction(run, refresh, round) {
  return appendWorkflowAction(run, "refresh_candidates", {
    round,
    works: refresh.stale.map((candidate) => ({
      displayTitle: candidate.display_title,
      sourceTitle: candidate.source_title,
      author: candidate.author,
      sourceBookId: candidate.source_book_id,
    })),
    discoveryNeeded: refresh.discoveryNeeded,
    shortlistSize: refresh.shortlistSize,
    checkedCanonicalWorks: refresh.shortlist.length,
    signals: ["rating", "rating_count", "reading_count", "highlight_top_count", "reviews_count", "signals_updated_at"],
    expansion: refresh.limits,
  }, { maxAttempts: 3 });
}

function selectAndBeginBatch(root, run) {
  const pipelinePath = path.join(root, "data", "book-pipeline.csv");
  assert(fs.existsSync(pipelinePath), `Missing candidate pipeline: ${pipelinePath}`);
  const rows = readCsvFile(pipelinePath).rows;
  const choice = chooseEligibleBooks(root, rows, run.input.needed);
  if (choice.selected.length < run.input.needed) {
    run.status = "blocked";
    run.blocker = {
      code: "candidate_shortage",
      message: `Only ${choice.selected.length} fresh eligible books are available; need ${run.input.needed}`,
      limits: { maxRounds: 3, maxWorks: 60 },
      rejected: choice.rejected,
    };
    return null;
  }
  const books = choice.selected.map((candidate) => candidate.title);
  const batch = beginReplenishmentBatch(root, books);
  run.batchId = batch.batchId;
  run.books = books;
  run.selection = choice.selected;
  return productionAction(run, books[0], 1, books.length);
}

export function startReplenishmentWorkflow(root, options = {}) {
  const inventory = verifiedPendingInventory(root);
  const pendingCount = inventory.pending.length;
  const summary = { pendingCount, threshold: REPLENISH_THRESHOLD, target: REPLENISH_TARGET };
  const existingRun = readWorkflowRun(root, { mode: "replenish" });
  if (existingRun?.status === "blocked") return existingRun;
  if (existingRun && !TERMINAL_STATUSES.has(existingRun.status)) {
    const action = currentAction(existingRun);
    assert(
      existingRun.status === "waiting" && action?.status === "pending",
      `Workflow ${existingRun.id} has no resumable replenish action`,
    );
    if (action.kind === "produce_episode") {
      verifyReplenishmentRetryContext(root, existingRun, action, { inventory });
    } else {
      assert(action.kind === "refresh_candidates", `Unsupported replenish action ${action.kind}`);
      verifyReplenishmentRefreshContext(root, existingRun, { inventory });
    }
    return existingRun;
  }
  if (pendingCount >= REPLENISH_THRESHOLD) return { status: "no_action", reason: "inventory_sufficient", ...summary };
  const batch = readReplenishmentBatch(root);
  if (batch?.status === "active") {
    return { status: "blocked", reason: "legacy_active_batch", batchId: batch.batchId, ...summary };
  }
  const needed = REPLENISH_TARGET - pendingCount;
  const pipelinePath = path.join(root, "data", "book-pipeline.csv");
  const rows = readCsvFile(pipelinePath).rows;
  const refresh = candidateRefreshPlan(rows, needed);
  if (options.dryRun) {
    return {
      status: refresh.requiresRefresh ? "would_refresh_candidates" : "would_begin_batch",
      needed,
      staleCount: refresh.stale.length,
      shortlistSize: refresh.shortlistSize,
      ...summary,
    };
  }
  const run = createWorkflowRun("replenish", { pendingCount, needed, threshold: REPLENISH_THRESHOLD, target: REPLENISH_TARGET });
  if (refresh.requiresRefresh) {
    candidateRefreshAction(run, refresh, 1);
  } else {
    selectAndBeginBatch(root, run);
  }
  return writeRun(root, run);
}

function firstPendingPublishItem(root) {
  const { queue, ledger } = verifiedPendingInventory(root);
  const item = [...queue.items].sort((left, right) => left.position - right.position)
    .find((entry) => entry.douyinStatus === "pending");
  if (!item) return null;
  return { item, history: summarizeProductionRelease(ledger, item.releaseId) };
}

function publishAction(run, item, history) {
  const latest = history.platforms.douyin.latestAttempt;
  if (["submission_unknown", "published_unrecorded"].includes(latest?.status)) {
    return appendWorkflowAction(run, "verify_existing_douyin_session", {
      sessionId: latest.sessionId,
      position: item.position,
      book: item.book,
      releaseId: item.releaseId,
      renderSha256: item.renderSha256,
      reuploadForbidden: true,
    });
  }
  if (latest && ["opening", "login_required", "preparing", "ready", "publishing", "published"].includes(latest.status)) {
    run.status = "blocked";
    run.blocker = { code: "unresolved_publication_session", sessionId: latest.sessionId, status: latest.status };
    return null;
  }
  const attemptNumber = history.platforms.douyin.attemptCount + 1;
  if (attemptNumber > 3) {
    run.status = "blocked";
    run.blocker = { code: "publication_attempt_limit", attempts: history.platforms.douyin.attemptCount };
    return null;
  }
  return appendWorkflowAction(run, "publish_douyin", {
    position: item.position,
    book: item.book,
    releaseId: item.releaseId,
    renderSha256: item.renderSha256,
    attemptNumber,
    maxSessions: 3,
    exactTitleVerificationRequired: true,
    viewportScreenshotRequired: true,
  }, { maxAttempts: 1 });
}

export function startPublishNextWorkflow(root, options = {}) {
  const selected = firstPendingPublishItem(root);
  if (!selected) return { status: "no_action", reason: "no_pending_douyin_release" };
  const batch = readReplenishmentBatch(root);
  if (batch?.status === "active") {
    return {
      status: "blocked",
      reason: "legacy_active_batch",
      batchId: batch.batchId,
      position: selected.item.position,
      book: selected.item.book,
    };
  }
  if (options.dryRun) {
    return {
      status: "would_publish",
      position: selected.item.position,
      book: selected.item.book,
      releaseId: selected.item.releaseId,
      renderSha256: selected.item.renderSha256,
    };
  }
  const run = createWorkflowRun("publish-next", {
    position: selected.item.position,
    book: selected.item.book,
    releaseId: selected.item.releaseId,
    renderSha256: selected.item.renderSha256,
  });
  publishAction(run, selected.item, selected.history);
  return writeRun(root, run);
}

export function completeWorkflowAction(run, expectedActionId, result = {}) {
  const action = currentAction(run);
  assert(action, `Workflow ${run.id} has no pending action`);
  assert(expectedActionId && expectedActionId === action.id, `Action id mismatch; expected ${action.id}`);
  assert(action.status === "pending", `Action ${action.id} was already ${action.status}`);
  action.status = "completed";
  action.completedAt = new Date().toISOString();
  action.result = result;
  run.currentActionId = null;
  run.stage = "advancing";
  run.status = "running";
  return action;
}

function resumeReplenishment(root, run, action) {
  if (action.kind === "refresh_candidates") {
    const rows = readCsvFile(path.join(root, "data", "book-pipeline.csv")).rows;
    const refresh = candidateRefreshPlan(rows, run.input.needed);
    completeWorkflowAction(run, action.id, {
      refreshed: refresh.shortlist.length - refresh.stale.length,
      stale: refresh.stale.length,
      discoveryNeeded: refresh.discoveryNeeded,
    });
    const round = Number(action.payload.round || 1);
    if (refresh.requiresRefresh && round < refresh.limits.maxRounds && refresh.shortlist.length < refresh.limits.maxWorks) {
      candidateRefreshAction(run, refresh, round + 1);
      return;
    }
    selectAndBeginBatch(root, run);
    return;
  }
  assert(action.kind === "produce_episode", `Unsupported replenish action ${action.kind}`);
  const completed = validateCompletedEpisode(root, action.payload.book, "", { requirePublish: true, requireQueue: true });
  const qa = validateEpisodeQa(root, completed);
  assert(completed.queueItem.releaseId, "Finalized episode has no immutable release");
  completeWorkflowAction(run, action.id, { releaseId: completed.queueItem.releaseId, renderSha256: completed.queueItem.renderSha256, qaPath: qa.filePath });
  const batch = readReplenishmentBatch(root, { required: true });
  const nextIndex = batch.items.findIndex((item) => item.stage === "pending");
  if (nextIndex === -1) {
    assert(batch.status === "complete", "Replenishment batch has no pending item but is not complete");
    run.status = "completed";
    run.stage = "completed";
    run.completedAt = new Date().toISOString();
  } else {
    productionAction(run, batch.items[nextIndex].book, nextIndex + 1, batch.items.length);
  }
}

function assertPublishIdentity(run, item) {
  assert(item, "Workflow publication item is missing from the active queue");
  assert(item.releaseId === run.input.releaseId, "Workflow release identity changed");
  assert(String(item.renderSha256).toLowerCase() === run.input.renderSha256, "Workflow render hash changed");
}

function resumePublish(root, run, action) {
  const queue = readPublishQueue(root, { required: true });
  const item = queue.items.find((entry) => entry.book === run.input.book);
  assertPublishIdentity(run, item);
  const ledger = readProductionLedger(root, { required: true });
  const history = summarizeProductionRelease(ledger, run.input.releaseId);
  if (["publish_douyin", "verify_existing_douyin_session"].includes(action.kind)) {
    if (item.douyinStatus === "published") {
      assert(history.platforms.douyin.everPublished, "Queue says published without trusted Douyin proof");
      completeWorkflowAction(run, action.id, { proofCount: history.platforms.douyin.proofCount });
      appendWorkflowAction(run, "handoff_xiaohongshu", {
        position: item.position,
        book: item.book,
        releaseId: item.releaseId,
        renderSha256: item.renderSha256,
        postCloseVerificationForbidden: true,
      });
      return;
    }
    const latest = history.platforms.douyin.latestAttempt;
    if (["submission_unknown", "published_unrecorded"].includes(latest?.status)) {
      if (action.kind !== "verify_existing_douyin_session") {
        completeWorkflowAction(run, action.id, { status: latest.status, sessionId: latest.sessionId });
        appendWorkflowAction(run, "verify_existing_douyin_session", {
          sessionId: latest.sessionId,
          position: item.position,
          book: item.book,
          releaseId: item.releaseId,
          renderSha256: item.renderSha256,
          reuploadForbidden: true,
        });
        return;
      }
      throw new Error(`Douyin verification is still unresolved for session ${latest.sessionId}`);
    }
    if (latest?.status === "failed") {
      completeWorkflowAction(run, action.id, { status: "failed", sessionId: latest.sessionId });
      if (history.platforms.douyin.attemptCount >= 3) {
      run.status = "blocked";
      run.stage = "blocked";
        run.blocker = { code: "publication_attempt_limit", attempts: history.platforms.douyin.attemptCount };
      } else {
        publishAction(run, item, history);
      }
      return;
    }
    throw new Error(`Douyin action is not complete; current status is ${latest?.status || "not_started"}`);
  }
  assert(action.kind === "handoff_xiaohongshu", `Unsupported publish action ${action.kind}`);
  const payloadPath = path.join(root, ".agents", "manual-publisher", "xiaohongshu", `${item.releaseId}.json`);
  assert(fs.existsSync(payloadPath), `Missing Xiaohongshu handoff payload: ${payloadPath}`);
  const payload = readJsonFile(payloadPath);
  assert(payload.releaseId === item.releaseId && payload.renderSha256 === item.renderSha256, "Xiaohongshu handoff identity mismatch");
  assert(Number.isFinite(Date.parse(payload.preparedAt)) && Date.parse(payload.preparedAt) >= Date.parse(action.createdAt), "Xiaohongshu handoff payload predates the workflow action");
  completeWorkflowAction(run, action.id, { payloadPath, preparedAt: payload.preparedAt });
  run.status = "completed";
  run.stage = "completed";
  run.completedAt = new Date().toISOString();
}

export function resumeWorkflow(root, options = {}) {
  const run = readWorkflowRun(root, { runId: options.runId, mode: options.mode });
  assert(run, "No workflow run found");
  if (TERMINAL_STATUSES.has(run.status)) return run;
  const action = currentAction(run);
  assert(action, `Workflow ${run.id} has no current action`);
  assert(String(options.actionId || "") === action.id, `Action id mismatch; expected ${action.id}`);
  if (run.mode === "replenish") resumeReplenishment(root, run, action);
  else resumePublish(root, run, action);
  return writeRun(root, run);
}

export function failWorkflowAction(root, options = {}) {
  const run = readWorkflowRun(root, { runId: options.runId, mode: options.mode });
  assert(run, "No workflow run found");
  const action = currentAction(run);
  assert(action && action.id === options.actionId, `Action id mismatch; expected ${action?.id || "none"}`);
  const errorClass = String(options.errorClass || "unknown");
  assert(WORKFLOW_ERROR_CLASSES.has(errorClass), `Unsupported workflow error class ${errorClass}`);
  if (["transient_tts", "transient_hyperframes"].includes(errorClass)) {
    assert(action.kind === "produce_episode", `${errorClass} is only retryable during episode production`);
  }
  if (errorClass === "qa_failure") {
    assert(run.mode === "replenish" && action.kind === "produce_episode", "qa_failure is only valid during episode production");
  }
  if (errorClass === "definite_publish_failure") {
    assert(
      run.mode === "publish-next" && ["publish_douyin", "verify_existing_douyin_session"].includes(action.kind),
      "definite_publish_failure is only valid for a Douyin publication action",
    );
  }
  action.attempts = (action.attempts || 0) + 1;
  action.lastError = { class: errorClass, message: String(options.message || ""), at: new Date().toISOString() };
  if (errorClass === "qa_failure" && action.attempts >= action.maxAttempts) {
    action.status = "failed";
    run.currentActionId = null;
    const rows = readCsvFile(path.join(root, "data", "book-pipeline.csv")).rows;
    const replacement = chooseReplacementBook(root, rows, [
      ...(run.books || []),
      ...(run.abandonedBooks || []),
    ]);
    if (!replacement) {
      run.status = "blocked";
      run.stage = "blocked";
      run.blocker = { code: "candidate_shortage_after_qa", abandonedBook: action.payload.book };
      return writeRun(root, run);
    }
    replacePendingReplenishmentBook(root, action.payload.book, replacement.title, {
      reason: "qa_rework_limit",
    });
    run.abandonedBooks = [...(run.abandonedBooks || []), action.payload.book];
    run.books[action.payload.index - 1] = replacement.title;
    run.selection = [...(run.selection || []), replacement];
    productionAction(run, replacement.title, action.payload.index, action.payload.total);
    return writeRun(root, run);
  }
  if (errorClass === "definite_publish_failure") {
    action.status = "failed";
    run.currentActionId = null;
    const queue = readPublishQueue(root, { required: true });
    const item = queue.items.find((entry) => entry.book === run.input.book);
    assertPublishIdentity(run, item);
    const ledger = readProductionLedger(root, { required: true });
    const history = summarizeProductionRelease(ledger, run.input.releaseId);
    if (history.platforms.douyin.attemptCount >= 3) {
      run.status = "blocked";
      run.stage = "blocked";
      run.blocker = { code: "publication_attempt_limit", attempts: history.platforms.douyin.attemptCount };
    } else {
      publishAction(run, item, history);
    }
    return writeRun(root, run);
  }
  if (NON_RETRYABLE_ERRORS.has(errorClass) || action.attempts >= action.maxAttempts) {
    action.status = "failed";
    run.status = "blocked";
    run.stage = "blocked";
    run.blocker = { code: errorClass, actionId: action.id, message: action.lastError.message };
  }
  return writeRun(root, run);
}

function retryWorkflowPlan(run, options = {}) {
  validateWorkflowRun(run);
  assert(run.mode === "replenish", "Only replenish workflows can be retried");
  assert(run.status === "blocked", "Only blocked workflows can be retried");
  const action = currentAction(run);
  assert(action && action.id === options.actionId, `Action id mismatch; expected ${action?.id || "none"}`);
  assert(action.kind === "produce_episode", "Only episode-production actions can be retried");
  assert(action.status === "failed", `Only failed actions can be retried; action is ${action.status}`);
  assert(action.attempts < action.maxAttempts, `Action retry limit reached (${action.attempts}/${action.maxAttempts})`);

  const currentErrorClass = String(action.lastError?.class || "").trim();
  const requestedErrorClass = options.errorClass === undefined ? "" : String(options.errorClass).trim();
  const reason = String(options.reason || "").trim();
  if (currentErrorClass === "unknown") {
    assert(
      requestedErrorClass === "transient_tts",
      "Unknown errors may only be reclassified explicitly as transient_tts",
    );
    assert(reason, "A non-empty retry reason is required when reclassifying an unknown error");
    return { action, currentErrorClass, effectiveErrorClass: requestedErrorClass, reason, reclassified: true };
  }

  assert(
    RETRYABLE_REPLENISHMENT_ERRORS.has(currentErrorClass),
    `Error class ${currentErrorClass || "missing"} is not retryable`,
  );
  assert(
    !requestedErrorClass || requestedErrorClass === currentErrorClass,
    `Retry error class must remain ${currentErrorClass}`,
  );
  return { action, currentErrorClass, effectiveErrorClass: currentErrorClass, reason, reclassified: false };
}

function verifyReplenishmentInventoryContext(root, run, options = {}) {
  const target = Number(run.input?.target);
  assert(Number.isInteger(target) && target === REPLENISH_TARGET, "Workflow replenishment target changed");
  const inventory = options.inventory || verifiedPendingInventory(root);
  assert(
    inventory.pending.length <= target,
    `Verified pending inventory exceeds replenishment target (${inventory.pending.length}/${target})`,
  );
  return inventory;
}

function verifyReplenishmentRefreshContext(root, run, options = {}) {
  const needed = Number(run.input?.needed);
  assert(Number.isInteger(needed) && needed > 0 && needed <= REPLENISH_TARGET, "Workflow replenishment needed count is invalid");
  const batch = readReplenishmentBatch(root);
  assert(batch?.status !== "active", `Candidate refresh workflow cannot resume with active batch ${batch?.batchId || "unknown"}`);
  verifyReplenishmentInventoryContext(root, run, options);
}

function verifyReplenishmentRetryContext(root, run, action, options = {}) {
  const batch = readReplenishmentBatch(root, { required: true });
  assert(batch.status === "active", `Stock replenishment batch ${batch.batchId} is not active`);
  assert(run.batchId === batch.batchId, "Workflow replenishment batch identity changed");
  const needed = Number(run.input?.needed);
  assert(Number.isInteger(needed) && needed === batch.items.length, "Workflow replenishment batch size changed");
  assert(Array.isArray(run.books) && run.books.length === batch.items.length, "Workflow replenishment book list changed");
  assert(
    run.books.every((book, itemIndex) => book === batch.items[itemIndex].book),
    "Workflow replenishment book order changed",
  );

  const index = Number(action.payload?.index);
  const book = String(action.payload?.book || "").trim();
  assert(Number.isInteger(index) && index >= 1 && book, "Workflow episode identity is invalid");
  assert(Number(action.payload?.total) === batch.items.length, "Workflow episode total changed");
  assert(run.books?.[index - 1] === book, "Workflow episode identity changed");
  const item = batch.items[index - 1];
  assert(item?.book === book && item.stage === "pending", "Current replenishment batch item changed");
  const nextPending = batch.items.find((entry) => entry.stage === "pending");
  assert(nextPending?.book === book, "Workflow action is not the current replenishment batch item");

  verifyReplenishmentInventoryContext(root, run, options);
}

function applyWorkflowRetry(run, plan) {
  const { action } = plan;
  const retriedAt = new Date().toISOString();
  if (plan.reclassified) {
    const reclassification = {
      from: plan.currentErrorClass,
      to: plan.effectiveErrorClass,
      reason: plan.reason,
      at: retriedAt,
    };
    action.errorReclassifications = [...(action.errorReclassifications || []), reclassification];
    action.lastError = {
      ...action.lastError,
      class: plan.effectiveErrorClass,
      reclassifiedAt: retriedAt,
    };
  }
  action.retryHistory = [
    ...(action.retryHistory || []),
    {
      at: retriedAt,
      errorClass: plan.effectiveErrorClass,
      ...(plan.reason ? { reason: plan.reason } : {}),
    },
  ];
  action.status = "pending";
  run.status = "waiting";
  run.stage = action.kind;
  delete run.blocker;
  validateWorkflowRun(run);
  return run;
}

export function retryWorkflowActionState(run, options = {}) {
  const plan = retryWorkflowPlan(run, options);
  return applyWorkflowRetry(run, plan);
}

export function retryWorkflowAction(root, options = {}) {
  const run = readWorkflowRun(root, { runId: options.runId, mode: options.mode });
  assert(run, "No workflow run found");
  const plan = retryWorkflowPlan(run, options);
  verifyReplenishmentRetryContext(root, run, plan.action);
  applyWorkflowRetry(run, plan);
  return writeRun(root, run);
}

export function verifyWorkflowRuns(root) {
  const directory = runsRoot(root);
  if (!fs.existsSync(directory)) return { count: 0, valid: true };
  const files = fs.readdirSync(directory).filter((name) => /^[0-9a-f-]+\.json$/u.test(name));
  for (const name of files) validateWorkflowRun(readJsonFile(path.join(directory, name)), path.join(directory, name));
  return { count: files.length, valid: true };
}

export function workflowSummary(run) {
  if (!run || !run.id) return run;
  const completedActions = run.actions.filter((action) => action.status === "completed");
  return {
    runId: run.id,
    mode: run.mode,
    status: run.status,
    stage: run.stage,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    input: run.input,
    inputHash: run.inputHash,
    currentAction: currentAction(run),
    completedActions: completedActions.length,
    lastCompletedAction: completedActions.at(-1) || null,
    blocker: run.blocker || null,
  };
}
