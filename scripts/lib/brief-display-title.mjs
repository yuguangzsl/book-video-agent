import { normalizeDisplayTitle } from "./title-normalization.mjs";

export function resolveBriefDisplayTitle(brief, fallbackTitle = "") {
  const preferredTitle = brief?.display_title || brief?.displayTitle || brief?.title || fallbackTitle;
  const sourceTitle = brief?.source_title || brief?.sourceTitle || preferredTitle || fallbackTitle;
  return normalizeDisplayTitle(sourceTitle, preferredTitle);
}
