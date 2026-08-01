import assert from "node:assert/strict";
import { resolveBriefDisplayTitle } from "../lib/brief-display-title.mjs";

assert.equal(
  resolveBriefDisplayTitle({ display_title: "合欢树(轻经典)", source_title: "合欢树（轻经典）" }),
  "合欢树",
);
assert.equal(
  resolveBriefDisplayTitle({ title: "精神与爱欲(果麦经典)" }),
  "精神与爱欲",
);
assert.equal(
  resolveBriefDisplayTitle({ displayTitle: "万寿寺", source_title: "万寿寺（2023版）" }),
  "万寿寺",
);

console.log("brief display title: ok");
