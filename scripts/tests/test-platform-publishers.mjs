import assert from "node:assert/strict";
import {
  descriptionContainsTopicName,
  descriptionHasExactTopic,
  douyinListTimestamp,
  platformCopyFor,
  topicCandidateMatches,
  xiaohongshuListTimestamp,
  xiaohongshuPublishClickPosition,
} from "../lib/platform-publishers.mjs";

assert.equal(topicCandidateMatches("#大地之上", "#大地之上"), true);
assert.equal(topicCandidateMatches("大地之上\n1.2 万人参与", "大地之上"), true);
assert.equal(topicCandidateMatches("#大地之上 1.2 万人参与", "大地之上"), true);
assert.equal(topicCandidateMatches("#现实压力\n510.2万", "现实压力"), true);
assert.equal(topicCandidateMatches("#现实压力\n510.2万\n#现实压力大\n6.9万", "现实压力"), false);
assert.equal(topicCandidateMatches("#大地之上的生活", "大地之上"), false);
assert.equal(topicCandidateMatches("#读书分享", "读书"), false);
assert.equal(topicCandidateMatches("", "读书"), false);
assert.equal(topicCandidateMatches("#读书", ""), false);

assert.equal(descriptionHasExactTopic("简介\n\n#大地之上 #读书", "大地之上"), true);
assert.equal(descriptionHasExactTopic("简介\u200b #尊严 ", "#尊严"), true);
assert.equal(descriptionHasExactTopic("简介 #普通人的命运\u2060 #读书\ufeff", "#普通人的命运"), true);
assert.equal(descriptionHasExactTopic("简介 #现实压力大 #尊严和爱情 #读书之美", "现实压力"), false);
assert.equal(descriptionHasExactTopic("简介 #现实压力大 #尊严和爱情 #读书之美", "尊严"), false);
assert.equal(descriptionHasExactTopic("简介 #现实压力大 #尊严和爱情 #读书之美", "读书"), false);

assert.equal(descriptionContainsTopicName("简介 #普通人的命运\u2060", "#普通人的命运"), true);
assert.equal(descriptionContainsTopicName("简介 #大地之上", "#大地之上"), true);
assert.equal(descriptionContainsTopicName("简介", "#大地之上"), false);

const platformBrief = {
  copy: {
    title: "common title",
    description: "common description",
    hashtags: ["#common"],
  },
  platformCopy: {
    douyin: {
      title: "douyin title",
      description: "douyin description",
      hashtags: ["#douyin"],
    },
    xiaohongshu: {
      title: "xiaohongshu title",
      description: "xiaohongshu description",
      hashtags: ["#xiaohongshu"],
    },
  },
};
assert.equal(platformCopyFor(platformBrief, "douyin").title, "douyin title");
assert.equal(platformCopyFor(platformBrief, "xiaohongshu").title, "xiaohongshu title");

assert.deepEqual(xiaohongshuPublishClickPosition(680, 90), { x: 414.8, y: 45 });
assert.throws(() => xiaohongshuPublishClickPosition(0, 90), /width must be positive/u);
assert.throws(() => xiaohongshuPublishClickPosition(680, 0), /height must be positive/u);
assert.equal(
  new Date(xiaohongshuListTimestamp("2026-07-30 15:19")).getFullYear(),
  2026,
);
assert.equal(xiaohongshuListTimestamp("昨天 15:19"), null);
assert.equal(
  new Date(douyinListTimestamp("2026年07月30日 15:19")).getFullYear(),
  2026,
);
assert.equal(douyinListTimestamp("昨天 15:19"), null);

console.log("platform publisher topic matching: ok");
