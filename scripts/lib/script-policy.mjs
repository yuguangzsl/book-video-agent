export const MAX_BODY_SCRIPT_LINES = 21;
export const MAX_BODY_SCRIPT_CHARS = 220;
export const TARGET_TOTAL_SCRIPT_LINES = Object.freeze({ minimum: 18, maximum: 20 });

export function validateBodyScript(rows) {
  const lines = rows.length;
  const totalLines = lines + 1;
  const chars = Array.from(rows.map((row) => String(row.text || "")).join("")).length;
  const errors = [];
  const warnings = [];
  if (lines > MAX_BODY_SCRIPT_LINES) errors.push(`正文最多 ${MAX_BODY_SCRIPT_LINES} 行，当前 ${lines} 行`);
  if (chars > MAX_BODY_SCRIPT_CHARS) errors.push(`正文最多 ${MAX_BODY_SCRIPT_CHARS} 个汉字，当前 ${chars} 个字符`);
  if (totalLines < TARGET_TOTAL_SCRIPT_LINES.minimum || totalLines > TARGET_TOTAL_SCRIPT_LINES.maximum) {
    warnings.push(`建议总行数为 ${TARGET_TOTAL_SCRIPT_LINES.minimum}-${TARGET_TOTAL_SCRIPT_LINES.maximum} 行（含书名），当前 ${totalLines} 行`);
  }
  const texts = rows.map((row) => String(row.text || ""));
  if (texts[0]?.includes("你是不是")) warnings.push("首句包含“你是不是”式营销表达");
  if (texts.some((text) => /不是.{0,20}而是/u.test(text))) warnings.push("正文包含“不是……而是……”式论证表达");
  if (texts.some((text) => /(?:点击|马上|立即)?(?:下单|购买)|购物车|点赞关注|关注收藏/u.test(text))) {
    warnings.push("正文包含 CTA 表达");
  }
  return { lines, totalLines, chars, errors, warnings };
}
