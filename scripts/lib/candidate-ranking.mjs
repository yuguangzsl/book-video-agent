import { normalizeDisplayTitle } from "./title-normalization.mjs";

export const HEAT_SCORE_VERSION = "weread-percentile-v1";
export const HEAT_SIGNAL_MAX_AGE_DAYS = 7;
export const CANDIDATE_SEARCH_MAX_ROUNDS = 3;
export const CANDIDATE_SEARCH_MAX_WORKS = 60;

const WEIGHTS = {
  reading_count: 0.50,
  rating_count: 0.25,
  reviews_count: 0.15,
  highlight_top_count: 0.10,
};

function number(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function canonicalAuthor(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^\[[^\]]+\]/u, "")
    .replace(/[·•・\s]/gu, "")
    .toLowerCase();
}

export function candidateWorkKey(candidate) {
  const title = normalizeDisplayTitle(
    candidate.source_title || candidate.sourceTitle || candidate.display_title || candidate.displayTitle || "",
    candidate.display_title || candidate.displayTitle || "",
  ).normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  return `${title}|${canonicalAuthor(candidate.author)}`;
}

function percentileRanks(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length <= 1) return values.map(() => 1);
  return values.map((value) => {
    let below = 0;
    let equal = 0;
    for (const candidate of sorted) {
      if (candidate < value) below += 1;
      else if (candidate === value) equal += 1;
    }
    return (below + Math.max(0, equal - 1) / 2) / (sorted.length - 1);
  });
}

export function signalsAreFresh(candidate, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxAgeDays = Number(options.maxAgeDays ?? HEAT_SIGNAL_MAX_AGE_DAYS);
  const updatedAt = Date.parse(candidate.signals_updated_at || candidate.signalsUpdatedAt || "");
  return Number.isFinite(updatedAt)
    && updatedAt <= now.getTime()
    && now.getTime() - updatedAt <= maxAgeDays * 24 * 60 * 60 * 1000;
}

export function scoreCandidatesByHeat(candidates) {
  const rows = candidates.map((candidate) => ({ ...candidate }));
  const ranks = Object.fromEntries(Object.keys(WEIGHTS).map((field) => [
    field,
    percentileRanks(rows.map((row) => number(row[field]))),
  ]));
  return rows.map((row, index) => {
    const heatScore = Object.entries(WEIGHTS)
      .reduce((sum, [field, weight]) => sum + ranks[field][index] * weight, 0);
    return {
      ...row,
      heat_score: Number(heatScore.toFixed(6)),
      heat_score_version: HEAT_SCORE_VERSION,
    };
  });
}

export function rankCanonicalCandidates(candidates, options = {}) {
  const eligible = candidates.filter((candidate) => (
    String(candidate.status || "candidate") === "candidate"
    && String(candidate.author || "").trim()
    && String(candidate.display_title || candidate.displayTitle || candidate.source_title || "").trim()
  ));
  const scored = scoreCandidatesByHeat(eligible);
  const byWork = new Map();
  for (const candidate of scored) {
    const key = candidateWorkKey(candidate);
    const current = byWork.get(key);
    const rating = number(candidate.rating);
    const currentRating = number(current?.rating);
    if (
      !current
      || candidate.heat_score > current.heat_score
      || (candidate.heat_score === current.heat_score && rating > currentRating)
    ) {
      byWork.set(key, candidate);
    }
  }
  return [...byWork.values()]
    .sort((left, right) => (
      right.heat_score - left.heat_score
      || number(right.rating) - number(left.rating)
      || candidateWorkKey(left).localeCompare(candidateWorkKey(right), "zh-CN")
    ))
    .slice(0, options.limit === undefined ? undefined : Number(options.limit));
}

export function candidateRefreshPlan(candidates, needed, options = {}) {
  const shortlistSize = Math.max(21, Math.max(1, Number(needed) || 1) * 3);
  const ranked = rankCanonicalCandidates(candidates, { limit: shortlistSize });
  const stale = ranked.filter((candidate) => !signalsAreFresh(candidate, options));
  const discoveryNeeded = Math.max(0, shortlistSize - ranked.length);
  return {
    shortlistSize,
    shortlist: ranked,
    stale,
    discoveryNeeded,
    requiresRefresh: stale.length > 0 || discoveryNeeded > 0,
    limits: {
      maxRounds: CANDIDATE_SEARCH_MAX_ROUNDS,
      maxWorks: CANDIDATE_SEARCH_MAX_WORKS,
    },
  };
}
