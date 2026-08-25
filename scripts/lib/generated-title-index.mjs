import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./filesystem.mjs";
import {
  findProductionWorksByIdentity,
  readProductionLedger,
} from "./production-ledger.mjs";
import { readAndValidateRenderManifest } from "./render-manifest.mjs";
import { normalizeDisplayTitle } from "./title-normalization.mjs";

function titleIndexPath(root) {
  return path.join(root, "data", "generated-book-titles.txt");
}

function titleKey(value) {
  return normalizeDisplayTitle(value).normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("zh-CN");
}

export function readGeneratedTitleIndex(root) {
  const filePath = titleIndexPath(root);
  if (!fs.existsSync(filePath)) return [];
  const titles = fs.readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeDisplayTitle(line));
  const unique = new Map();
  for (const title of titles) {
    const key = titleKey(title);
    if (!unique.has(key)) unique.set(key, title);
  }
  return [...unique.values()];
}

export function recordGeneratedTitle(root, displayTitle) {
  const normalized = normalizeDisplayTitle(displayTitle);
  const titles = readGeneratedTitleIndex(root);
  if (!titles.some((title) => titleKey(title) === titleKey(normalized))) titles.push(normalized);
  titles.sort((left, right) => left.localeCompare(right, "zh-CN"));
  const filePath = titleIndexPath(root);
  writeFileAtomically(filePath, `${titles.join("\n")}\n`, { encoding: "utf8" });
  return { filePath, title: normalized, titles };
}

export function scanValidatedRenderTitles(root, options = {}) {
  const episodesRoot = path.join(root, "episodes");
  const titles = [];
  const warnings = [];
  if (!fs.existsSync(episodesRoot)) return { titles, warnings };
  const manifestReader = options.manifestReader
    || ((manifestPath) => readAndValidateRenderManifest(root, manifestPath, { verifyMedia: true }));

  for (const entry of fs.readdirSync(episodesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rendersDir = path.join(episodesRoot, entry.name, "renders");
    if (!fs.existsSync(rendersDir)) continue;
    const manifests = fs.readdirSync(rendersDir, { withFileTypes: true })
      .filter((item) => item.isFile() && item.name.endsWith(".manifest.json"))
      .map((item) => path.join(rendersDir, item.name));
    if (manifests.length !== 1) continue;
    try {
      const result = manifestReader(manifests[0]);
      const title = normalizeDisplayTitle(result.manifest?.episode?.name || entry.name);
      if (title) titles.push(title);
    } catch (error) {
      warnings.push(`${entry.name}: ${error.message}`);
    }
  }
  return { titles, warnings };
}

export function checkBookEligibility(root, displayTitle, options = {}) {
  const normalized = normalizeDisplayTitle(displayTitle);
  const key = titleKey(normalized);
  const indexMatches = readGeneratedTitleIndex(root).filter((title) => titleKey(title) === key);
  const renderScan = scanValidatedRenderTitles(root, options);
  const renderMatches = renderScan.titles.filter((title) => titleKey(title) === key);
  const ledger = readProductionLedger(root);
  const productionHistory = ledger ? findProductionWorksByIdentity(ledger, normalized) : [];
  const everGenerated = productionHistory.some((work) => work.everGenerated) || renderMatches.length > 0;
  const everReleased = productionHistory.some((work) => work.everReleased);
  const duplicate = indexMatches.length > 0 || renderMatches.length > 0 || productionHistory.length > 0;
  return {
    displayTitle: normalized,
    eligible: !duplicate || Boolean(options.maintenance),
    duplicate,
    everGenerated,
    everReleased,
    everPublished: {
      douyin: productionHistory.some((work) => work.platforms.douyin.everPublished),
      xiaohongshu: productionHistory.some((work) => work.platforms.xiaohongshu.everPublished),
    },
    legacyDuplicateOnly: indexMatches.length > 0 && !everGenerated,
    maintenance: Boolean(options.maintenance),
    matches: {
      titleIndex: indexMatches,
      validatedRenders: renderMatches,
      productionHistory,
    },
    warnings: renderScan.warnings,
  };
}

export function assertBookEligible(root, displayTitle, options = {}) {
  const result = checkBookEligibility(root, displayTitle, options);
  if (!result.eligible) {
    throw new Error(`Book has already been generated: ${result.displayTitle}`);
  }
  return result;
}
