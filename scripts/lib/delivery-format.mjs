import fs from "node:fs";
import path from "node:path";
import { formatMarkdownLocalPath } from "./artifact-paths.mjs";

export function formatPreviewDelivery(previewPath) {
  if (typeof previewPath !== "string" || !path.isAbsolute(previewPath)) {
    throw new Error("Preview path must be absolute");
  }
  if (!fs.existsSync(previewPath) || !fs.statSync(previewPath).isFile()) {
    throw new Error(`Preview file does not exist: ${previewPath}`);
  }
  return `预览文件路径：[打开预览](${formatMarkdownLocalPath(previewPath)})`;
}
