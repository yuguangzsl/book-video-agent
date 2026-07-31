#!/usr/bin/env node

import { formatPreviewDelivery } from "./lib/delivery-format.mjs";

const [previewPath, ...extra] = process.argv.slice(2);
if (!previewPath || extra.length) {
  console.error("Usage: node scripts/format-preview-delivery.mjs <absolute-preview-path>");
  process.exit(1);
}
console.log(formatPreviewDelivery(previewPath));
