#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./lib/filesystem.mjs";
import { readPublishJson, validatePublishJsonAgainstManifest } from "./lib/publish-json.mjs";
import { readPublishQueue } from "./lib/publish-queue.mjs";
import { readAndValidateRenderManifest } from "./lib/render-manifest.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const maintenance = args.includes("--maintenance");
const positional = args.filter((arg) => !arg.startsWith("--"));
const [episodeName, requestedVersion = ""] = positional;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (!episodeName || !maintenance || positional.length > 2) {
  console.error("Usage: node scripts/sync-publish-render-hash.mjs <episode-name> [script-version] --maintenance");
  process.exit(1);
}

const episodesRoot = path.resolve(ROOT, "episodes");
const episodeDir = path.resolve(episodesRoot, episodeName);
assert(path.dirname(episodeDir) === episodesRoot, `Episode name must identify one direct child of episodes/: ${episodeName}`);
assert(fs.existsSync(episodeDir) && fs.statSync(episodeDir).isDirectory(), `Episode not found: ${episodeDir}`);

const rendersDir = path.join(episodeDir, "renders");
const manifests = fs.readdirSync(rendersDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".manifest.json"));
assert(manifests.length === 1, `Expected exactly one render manifest for ${episodeName}, found ${manifests.length}`);

const manifestPath = path.join(rendersDir, manifests[0].name);
const { manifest } = readAndValidateRenderManifest(ROOT, manifestPath, { verifyMedia: true });
assert(manifest.episode.name === episodeName, "Render manifest episode.name does not match the episode directory");
if (requestedVersion) {
  assert(manifest.episode.scriptVersion === requestedVersion, `Render manifest is for ${manifest.episode.scriptVersion}, not ${requestedVersion}`);
}

const publishPath = path.join(episodeDir, "publish.json");
assert(fs.existsSync(publishPath), `Missing publish.json: ${publishPath}`);
const publish = readPublishJson(publishPath);
assert(publish.book === manifest.episode.name, "publish.json book does not match the render manifest");
assert(publish.inputs.scriptVersion === manifest.episode.scriptVersion, "publish.json scriptVersion does not match the render manifest");
assert(
  publish.inputs.scriptSha256.toLowerCase() === manifest.inputs.script.sha256.toLowerCase(),
  "publish.json scriptSha256 does not match the render manifest",
);

const renderSha256 = manifest.output.sha256.toLowerCase();
const previousRenderSha256 = publish.inputs.renderSha256.toLowerCase();
const queue = readPublishQueue(ROOT);
const queued = queue?.items.find((item) => item.book === episodeName);
assert(
  !queued || String(queued.renderSha256).toLowerCase() === renderSha256,
  `Refusing to sync ${episodeName}: its active publication queue item still points to another immutable render`,
);

const updated = {
  ...publish,
  inputs: {
    ...publish.inputs,
    renderSha256,
  },
};
validatePublishJsonAgainstManifest(updated, manifest, publishPath);
writeFileAtomically(publishPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8" });
validatePublishJsonAgainstManifest(readPublishJson(publishPath), manifest, publishPath);

console.log(JSON.stringify({
  book: episodeName,
  scriptVersion: manifest.episode.scriptVersion,
  previousRenderSha256,
  renderSha256,
  changed: previousRenderSha256 !== renderSha256,
}, null, 2));
