// Token refresh adapter registry.
// Maps each Channel enum value to its refresh adapter.

import { youtubeRefresh } from "./youtube.refresh.js";
import { xRefresh } from "./x.refresh.js";
import { tiktokRefresh } from "./tiktok.refresh.js";
import { metaRefresh } from "./meta.refresh.js";
import { linkedinRefresh } from "./linkedin.refresh.js";

const ADAPTERS = {
  YOUTUBE: youtubeRefresh,
  X: xRefresh,
  TIKTOK: tiktokRefresh,
  INSTAGRAM: metaRefresh,
  FACEBOOK: metaRefresh,
  LINKEDIN: linkedinRefresh,
};

export function getRefreshAdapter(channel) {
  return ADAPTERS[channel] ?? null;
}
