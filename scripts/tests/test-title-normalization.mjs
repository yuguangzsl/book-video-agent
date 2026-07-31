import assert from "node:assert/strict";
import { normalizeDisplayTitle } from "../lib/title-normalization.mjs";

assert.equal(normalizeDisplayTitle("某本书：“副标题说明”"), "某本书");
assert.equal(normalizeDisplayTitle("《书名示例》（经典版）"), "书名示例");
assert.equal(normalizeDisplayTitle("长篇小说（2022新版）"), "长篇小说");
assert.equal(normalizeDisplayTitle("秋天的怀念(轻经典)"), "秋天的怀念");
assert.equal(normalizeDisplayTitle("克林索尔的最后夏天(果麦经典)"), "克林索尔的最后夏天");
assert.equal(
  normalizeDisplayTitle("大地之上(一幅印度社会各阶层的全景式画卷,比《活着》更为惨痛的民族血泪史!)"),
  "大地之上",
);
assert.equal(normalizeDisplayTitle("短书名"), "短书名");
console.log("title normalization: ok");
