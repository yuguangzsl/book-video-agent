import path from "node:path";

export const XIAOHONGSHU_PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizedHashtags(values) {
  assert(Array.isArray(values), "Xiaohongshu hashtags must be an array");
  const hashtags = values.map((value) => {
    const tag = String(value || "").trim();
    assert(tag, "Xiaohongshu hashtags must not be empty");
    return tag.startsWith("#") ? tag : `#${tag}`;
  });
  assert(hashtags.length >= 3 && hashtags.length <= 5, "Xiaohongshu requires 3-5 hashtags");
  return hashtags;
}

export function buildXiaohongshuManualPayload(brief, options = {}) {
  assert(brief && typeof brief === "object", "Publication brief is required");
  assert(brief.platformCopy?.xiaohongshu, "Publication brief has no Xiaohongshu copy");
  assert(typeof brief.videoPath === "string" && path.isAbsolute(brief.videoPath), "Xiaohongshu videoPath must be absolute");
  assert(/^[a-f0-9]{64}$/u.test(String(brief.releaseId || "")), "Xiaohongshu releaseId is invalid");
  assert(/^[a-f0-9]{64}$/u.test(String(brief.renderSha256 || "")), "Xiaohongshu renderSha256 is invalid");

  const copy = brief.platformCopy.xiaohongshu;
  const title = String(copy.title || "").trim();
  const description = String(copy.description || "").trim();
  const hashtags = normalizedHashtags(copy.hashtags);
  assert(title, "Xiaohongshu title is required");
  assert(description, "Xiaohongshu description is required");

  const policy = brief.settings || {};
  return {
    schemaVersion: 1,
    platform: "xiaohongshu",
    testMode: options.testMode === true,
    publishUrl: XIAOHONGSHU_PUBLISH_URL,
    queuePosition: brief.queuePosition,
    book: brief.book,
    releaseId: brief.releaseId,
    renderSha256: brief.renderSha256,
    videoPath: brief.videoPath,
    videoFileName: path.basename(brief.videoPath),
    title,
    description,
    hashtags,
    hashtagText: hashtags.join(" "),
    settings: [
      { label: "AI 生成内容声明", value: policy.aiGenerated === true ? "开启" : "关闭" },
      { label: "原创声明", value: policy.originalDeclaration === true ? "开启" : "关闭" },
      { label: "允许下载", value: policy.allowDownload === true ? "开启" : "关闭" },
      { label: "商业推广", value: policy.commercialPromotion === true ? "开启" : "关闭" },
      { label: "可见范围", value: policy.visibility === "public" ? "公开" : String(policy.visibility || "按发布清单") },
      { label: "发布时间", value: policy.timing === "immediate" ? "立即发布" : String(policy.timing || "按发布清单") },
      { label: "封面", value: policy.cover === "first-frame" ? "首帧" : String(policy.cover || "按发布清单") },
      { label: "地点", value: String(policy.location || "").trim() || "不填写" },
    ],
  };
}
