import fs from "node:fs";
import path from "node:path";

function rollbackFiles(states) {
  const failures = [];
  for (const state of [...states].reverse()) {
    try {
      if (state.activated && fs.existsSync(state.destination)) {
        fs.mkdirSync(path.dirname(state.source), { recursive: true });
        fs.renameSync(state.destination, state.source);
      }
      if (state.backup && fs.existsSync(state.backup)) fs.renameSync(state.backup, state.destination);
    } catch (error) {
      failures.push(`${state.destination}: ${error.message}`);
    }
  }
  return failures;
}

export function replaceFilesWithRollback(entries, backupDir, afterActivate = () => undefined) {
  fs.mkdirSync(backupDir, { recursive: true });
  const states = entries.map((entry, index) => ({
    source: path.resolve(entry.source),
    destination: path.resolve(entry.destination),
    backup: null,
    activated: false,
    index,
  }));

  try {
    for (const state of states) {
      if (!fs.existsSync(state.source) || !fs.statSync(state.source).isFile()) {
        throw new Error(`Replacement source is missing: ${state.source}`);
      }
      fs.mkdirSync(path.dirname(state.destination), { recursive: true });
      if (fs.existsSync(state.destination)) {
        state.backup = path.join(backupDir, `${String(state.index).padStart(2, "0")}-${path.basename(state.destination)}`);
        fs.renameSync(state.destination, state.backup);
      }
      fs.renameSync(state.source, state.destination);
      state.activated = true;
    }
    return afterActivate();
  } catch (error) {
    const rollbackFailures = rollbackFiles(states);
    if (rollbackFailures.length) {
      throw new Error(`${error.message}; rollback also failed: ${rollbackFailures.join(" | ")}`, { cause: error });
    }
    throw error;
  }
}
