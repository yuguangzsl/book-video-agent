import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateAssetProvenance } from "../lib/asset-provenance.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-asset-provenance-test-"));
const provenancePath = path.join(root, "templates", "shared-video-template", "ASSET_PROVENANCE.csv");
const mediaPath = path.join(root, "assets", "bgm", "test.mp3");

try {
  fs.mkdirSync(path.dirname(provenancePath), { recursive: true });
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.writeFileSync(mediaPath, "audio");
  const header = "path,generation_date,generation_tool,prompt_id,human_review,redistribution_decision\n";
  fs.writeFileSync(
    provenancePath,
    `${header}assets/bgm/test.mp3,2026-07,user-provided,test,reviewed,redistribution-authorized\n`,
  );
  assert.equal(validateAssetProvenance(root).mediaCount, 1);

  fs.writeFileSync(provenancePath, header);
  assert.throws(() => validateAssetProvenance(root), /missing provenance row/);

  fs.writeFileSync(
    provenancePath,
    `${header}assets/bgm/test.mp3,2026-07,user-provided,test,pending,unconfirmed\n`,
  );
  assert.throws(() => validateAssetProvenance(root), /human reviewed/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("asset provenance: ok");
