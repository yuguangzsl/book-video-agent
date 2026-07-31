import assert from "node:assert/strict";
import { validateBodyScript } from "../lib/script-policy.mjs";

const target = validateBodyScript(Array.from({ length: 18 }, (_, index) => ({ text: `第${index + 1}行。` })));
assert.equal(target.errors.length, 0);
assert.equal(target.warnings.length, 0);
assert.equal(target.totalLines, 19);

const short = validateBodyScript([{ text: "你是不是也这样？" }, { text: "不是懒，而是累。" }, { text: "立即购买。" }]);
assert.match(short.warnings.join("\n"), /建议总行数/);
assert.match(short.warnings.join("\n"), /你是不是/);
assert.match(short.warnings.join("\n"), /不是……而是/);
assert.match(short.warnings.join("\n"), /CTA/);

const tooLong = validateBodyScript(Array.from({ length: 22 }, () => ({ text: "字" })));
assert.match(tooLong.errors.join("\n"), /正文最多 21 行/);

console.log("script policy: ok");
