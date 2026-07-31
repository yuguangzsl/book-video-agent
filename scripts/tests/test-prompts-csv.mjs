import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAndValidatePrompts } from "../lib/prompts-csv.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-prompts-test-"));
const filePath = path.join(root, "prompts.csv");
const header = "asset_id,purpose,prompt,generator,source,status\n";
const rows = ["result-bridge", "atmosphere-1", "atmosphere-2", "atmosphere-3"]
  .map((id) => `${id},purpose,prompt,imagegen,AI-generated,approved`);

try {
  fs.writeFileSync(filePath, `${header}${rows.join("\n")}\n`);
  assert.equal(readAndValidatePrompts(filePath).length, 4);
  fs.writeFileSync(filePath, `${header}${rows.slice(0, 3).join("\n")}\n`);
  assert.throws(() => readAndValidatePrompts(filePath), /expected exactly 4/);
  fs.writeFileSync(filePath, `${header}${rows.slice(0, 3).join("\n")}\natmosphere-3,purpose,prompt,imagegen,user-provided,approved\n`);
  assert.throws(() => readAndValidatePrompts(filePath), /source must be AI-generated/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("prompts csv: ok");
