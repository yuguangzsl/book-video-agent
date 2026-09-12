import assert from "node:assert/strict";
import {
  candidateRefreshPlan,
  candidateWorkKey,
  rankCanonicalCandidates,
  signalsAreFresh,
} from "../lib/candidate-ranking.mjs";

const now = new Date("2026-09-03T05:00:00.000Z");
const candidates = [
  { status: "candidate", display_title: "书甲(精装版)", source_title: "书甲（精装版）", author: "[中] 作者甲", reading_count: 100, rating_count: 10, reviews_count: 3, highlight_top_count: 2, rating: 900, signals_updated_at: "2026-09-02T00:00:00.000Z" },
  { status: "candidate", display_title: "书甲", source_title: "书甲", author: "作者甲", reading_count: 200, rating_count: 20, reviews_count: 5, highlight_top_count: 4, rating: 880, signals_updated_at: "2026-09-02T00:00:00.000Z" },
  { status: "candidate", display_title: "书乙", source_title: "书乙", author: "作者乙", reading_count: 50, rating_count: 100, reviews_count: 10, highlight_top_count: 10, rating: 960, signals_updated_at: "2026-08-01T00:00:00.000Z" },
];

assert.equal(candidateWorkKey(candidates[0]), candidateWorkKey(candidates[1]));
const ranked = rankCanonicalCandidates(candidates);
assert.equal(ranked.length, 2);
assert.equal(ranked[0].display_title, "书甲");
assert.equal(ranked[0].heat_score_version, "weread-percentile-v1");
assert.equal(signalsAreFresh(ranked[0], { now }), true);
assert.equal(signalsAreFresh(ranked[1], { now }), false);
const refresh = candidateRefreshPlan(candidates, 7, { now });
assert.equal(refresh.shortlistSize, 21);
assert.equal(refresh.requiresRefresh, true);
assert.equal(refresh.stale.length, 1);
assert.equal(refresh.discoveryNeeded, 19);
assert.deepEqual(refresh.limits, { maxRounds: 3, maxWorks: 60 });
