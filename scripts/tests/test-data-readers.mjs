import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCsvFile, serializeCsv } from "../lib/csv.mjs";
import { readJsonFile } from "../lib/json.mjs";
import { resolveScriptVersion } from "../lib/script-version.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-data-reader-test-"));
try {
  const csvPath = path.join(root, "quoted.csv");
  fs.writeFileSync(csvPath, '\uFEFFversion,order,text\nv1,1,"逗号，和英文,逗号"\n');
  assert.deepEqual(readCsvFile(csvPath, { requiredHeaders: ["version", "order", "text"] }).rows, [
    { version: "v1", order: "1", text: "逗号，和英文,逗号" },
  ]);
  assert.equal(serializeCsv(["a", "b"], [{ a: "x,y", b: 'a"b' }]), 'a,b\n"x,y","a""b"\n');

  const jsonPath = path.join(root, "data.json");
  fs.writeFileSync(jsonPath, '\uFEFF{"ok":true}\n');
  assert.deepEqual(readJsonFile(jsonPath), { ok: true });

  const uniqueEpisode = path.join(root, "unique");
  fs.mkdirSync(uniqueEpisode);
  fs.writeFileSync(path.join(uniqueEpisode, "script.csv"), "version,order,text\nv2,1,文本\n");
  assert.equal(resolveScriptVersion(uniqueEpisode), "v2");

  const briefEpisode = path.join(root, "brief");
  fs.mkdirSync(briefEpisode);
  fs.writeFileSync(path.join(briefEpisode, "brief.json"), '\uFEFF{"scriptVersion":"v3"}\n');
  assert.equal(resolveScriptVersion(briefEpisode), "v3");

  const ambiguousEpisode = path.join(root, "ambiguous");
  fs.mkdirSync(ambiguousEpisode);
  fs.writeFileSync(path.join(ambiguousEpisode, "script.csv"), "version,order,text\nv1,1,一\nv2,1,二\n");
  assert.throws(() => resolveScriptVersion(ambiguousEpisode), /ambiguous.*v1, v2/u);

  const missingEpisode = path.join(root, "missing");
  fs.mkdirSync(missingEpisode);
  assert.throws(() => resolveScriptVersion(missingEpisode), /Could not resolve script version/u);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("data readers: ok");
