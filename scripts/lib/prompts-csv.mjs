import path from "node:path";
import { readCsvFile } from "./csv.mjs";
import { EPISODE_IMAGE_FILENAMES } from "./project-constants.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function readAndValidatePrompts(filePath) {
  const { rows } = readCsvFile(filePath, {
    requiredHeaders: ["asset_id", "purpose", "prompt", "generator", "source", "status"],
  });
  const expectedIds = EPISODE_IMAGE_FILENAMES.map((name) => path.basename(name, path.extname(name)));
  assert(rows.length === expectedIds.length, `${filePath}: expected exactly ${expectedIds.length} prompt rows`);
  const byId = new Map();
  for (const row of rows) {
    assert(expectedIds.includes(row.asset_id), `${filePath}: unsupported asset_id ${row.asset_id}`);
    assert(!byId.has(row.asset_id), `${filePath}: duplicate asset_id ${row.asset_id}`);
    for (const field of ["purpose", "prompt", "generator"]) {
      assert(typeof row[field] === "string" && row[field].trim(), `${filePath}: ${row.asset_id}.${field} must be non-empty`);
    }
    assert(row.source === "AI-generated", `${filePath}: ${row.asset_id}.source must be AI-generated`);
    assert(row.status === "approved", `${filePath}: ${row.asset_id}.status must be approved`);
    byId.set(row.asset_id, row);
  }
  for (const assetId of expectedIds) {
    assert(byId.has(assetId), `${filePath}: missing prompt row for ${assetId}`);
  }
  return expectedIds.map((assetId) => byId.get(assetId));
}
