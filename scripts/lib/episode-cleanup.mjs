import fs from "node:fs";
import path from "node:path";
import { readGeneratedTitleIndex, recordGeneratedTitle } from "./generated-title-index.mjs";
import { readJsonFile } from "./json.mjs";
import { readPublishQueue } from "./publish-queue.mjs";
import { readAndValidateRenderManifest } from "./render-manifest.mjs";
import { readReplenishmentBatch } from "./replenishment-batch.mjs";
import { removeDirectory } from "./filesystem.mjs";
import { normalizeDisplayTitle } from "./title-normalization.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function assertDirectEpisodePath(root, episodePath) {
  const episodesRoot = path.resolve(root, "episodes");
  const resolved = path.resolve(episodePath);
  if (path.dirname(resolved) !== episodesRoot) {
    throw new Error(`Episode cleanup target must be a direct child of ${episodesRoot}: ${resolved}`);
  }
  return resolved;
}

function readDisplayTitle(episodeDir, fallback) {
  const briefPath = path.join(episodeDir, "brief.json");
  if (!fs.existsSync(briefPath)) return normalizeDisplayTitle(fallback);
  const brief = readJsonFile(briefPath);
  return normalizeDisplayTitle(brief.display_title || brief.displayTitle || brief.title || fallback);
}

function activeEpisodeNames(root) {
  const active = new Set();
  const queue = readPublishQueue(root);
  for (const item of queue?.items || []) {
    if (item.douyinStatus === "pending" || item.xiaohongshuStatus === "pending") active.add(item.book);
  }
  const batch = readReplenishmentBatch(root);
  if (batch?.status === "active") {
    for (const item of batch.items) active.add(item.book);
  }
  return active;
}

function resolveGeneratedTime(root, episodeDir, options, warnings) {
  const rendersDir = path.join(episodeDir, "renders");
  if (!fs.existsSync(rendersDir)) return null;
  const entries = fs.readdirSync(rendersDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  const manifests = entries.filter((entry) => entry.name.endsWith(".manifest.json"));
  const videos = entries.filter((entry) => entry.name.toLowerCase().endsWith(".mp4"));
  if (manifests.length === 1) {
    const manifestPath = path.join(rendersDir, manifests[0].name);
    const manifestReader = options.manifestReader
      || ((filePath) => readAndValidateRenderManifest(root, filePath, { verifyMedia: true }));
    try {
      const result = manifestReader(manifestPath);
      const timestamp = Date.parse(result.manifest?.createdAt || "");
      if (Number.isFinite(timestamp)) return { timestamp, source: "validated-manifest" };
      warnings.push("validated manifest has no trustworthy createdAt");
    } catch (error) {
      warnings.push(`manifest validation failed: ${error.message}`);
    }
  }
  if (videos.length === 1) {
    return {
      timestamp: fs.statSync(path.join(rendersDir, videos[0].name)).mtimeMs,
      source: "final-video-mtime",
    };
  }
  return null;
}

export function inventoryEpisodeCleanup(root, options = {}) {
  const episodesRoot = path.resolve(root, "episodes");
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const active = activeEpisodeNames(root);
  const items = [];
  if (!fs.existsSync(episodesRoot)) return { now: new Date(now).toISOString(), items };

  for (const entry of fs.readdirSync(episodesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const episodeDir = assertDirectEpisodePath(root, path.join(episodesRoot, entry.name));
    const warnings = [];
    const displayTitle = readDisplayTitle(episodeDir, entry.name);
    const generated = resolveGeneratedTime(root, episodeDir, options, warnings);
    const isActive = active.has(entry.name);
    const ageMs = generated ? now - generated.timestamp : null;
    const eligible = !isActive && Number.isFinite(ageMs) && ageMs > 7 * DAY_MS;
    items.push({
      episode: entry.name,
      displayTitle,
      path: episodeDir,
      active: isActive,
      generatedAt: generated ? new Date(generated.timestamp).toISOString() : null,
      ageDays: Number.isFinite(ageMs) ? Number((ageMs / DAY_MS).toFixed(2)) : null,
      timestampSource: generated?.source || null,
      eligible,
      reason: isActive
        ? "active"
        : !generated
          ? "untrusted-age"
          : eligible
            ? "older-than-seven-full-days"
            : "newer-than-seven-full-days",
      warnings,
    });
  }
  return { now: new Date(now).toISOString(), items };
}

export function cleanupEpisodes(root, options = {}) {
  const inventory = inventoryEpisodeCleanup(root, options);
  const removed = [];
  if (options.apply) {
    for (const item of inventory.items.filter((entry) => entry.eligible)) {
      const episodePath = assertDirectEpisodePath(root, item.path);
      recordGeneratedTitle(root, item.displayTitle);
      removeDirectory(episodePath);
      removed.push({ title: item.displayTitle, path: episodePath });
    }
  }
  return {
    apply: Boolean(options.apply),
    removed,
    generatedTitles: readGeneratedTitleIndex(root),
    ...inventory,
  };
}
