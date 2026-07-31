import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatPreviewDelivery } from "../lib/delivery-format.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-preview-delivery-test-"));

try {
  const previewPath = path.join(root, "预览 (v1).mp4");
  fs.writeFileSync(previewPath, "video");
  assert.match(
    formatPreviewDelivery(previewPath),
    /^预览文件路径：\[打开预览\]\(<.+预览 \(v1\)\.mp4>\)$/u,
  );
  assert.throws(() => formatPreviewDelivery("relative.mp4"), /must be absolute/);
  assert.throws(() => formatPreviewDelivery(path.join(root, "missing.mp4")), /does not exist/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("delivery format: ok");
