#!/usr/bin/env node

import {
  failWorkflowAction,
  readWorkflowRun,
  retryWorkflowAction,
  resumeWorkflow,
  startPublishNextWorkflow,
  startReplenishmentWorkflow,
  verifyWorkflowRuns,
  workflowSummary,
} from "./lib/workflow-run.mjs";

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      options._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else options[key] = true;
  }
  return options;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  const root = process.cwd();
  if (command === "replenish") print(workflowSummary(startReplenishmentWorkflow(root, { dryRun: args["dry-run"] === true })));
  else if (command === "publish-next") print(workflowSummary(startPublishNextWorkflow(root, { dryRun: args["dry-run"] === true })));
  else if (command === "status") {
    if (args.run || args.mode) {
      const mode = args.mode || "replenish";
      print(workflowSummary(readWorkflowRun(root, { runId: args.run, mode })) || { status: "not_found", mode });
    } else {
      print({
        replenish: workflowSummary(readWorkflowRun(root, { mode: "replenish" })) || { status: "not_found" },
        publishNext: workflowSummary(readWorkflowRun(root, { mode: "publish-next" })) || { status: "not_found" },
      });
    }
  } else if (command === "resume") {
    print(workflowSummary(resumeWorkflow(root, { runId: args.run, mode: args.mode, actionId: args["action-id"] })));
  } else if (command === "fail") {
    print(workflowSummary(failWorkflowAction(root, {
      runId: args.run,
      mode: args.mode,
      actionId: args["action-id"],
      errorClass: args["error-class"],
      message: args.message,
    })));
  } else if (command === "retry") {
    print(workflowSummary(retryWorkflowAction(root, {
      runId: args.run,
      mode: args.mode,
      actionId: args["action-id"],
      errorClass: args["error-class"],
      reason: args.reason,
    })));
  } else if (command === "verify") print(verifyWorkflowRuns(root));
  else {
    throw new Error("Usage: workflow <replenish|publish-next|status|resume|fail|retry|verify> [--dry-run] [--run id] [--mode mode] [--action-id id]");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
  process.exitCode = 1;
}
