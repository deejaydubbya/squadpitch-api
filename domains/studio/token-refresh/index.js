// Token refresh adapter registry.
// Maps each Channel enum value to its refresh adapter.

import { youtubeRefresh } from "./youtube.refresh.js";
import { xRefresh } from "./x.refresh.js";
import { tiktokRefresh } from "./tiktok.refresh.js";
import { metaRefresh } from "./meta.refresh.js";
import { linkedinRefresh } from "./linkedin.refresh.js";
import { threadsRefresh } from "./threads.refresh.js";
import { instagramRefresh } from "./instagram.refresh.js";

const ADAPTERS = {
  YOUTUBE: youtubeRefresh,
  X: xRefresh,
  TIKTOK: tiktokRefresh,
  // Instagram migrated off Facebook Login (Prompt 01) — it now
  // refreshes via graph.instagram.com/refresh_access_token with
  // grant_type=ig_refresh_token. Facebook keeps metaRefresh
  // because Page tokens in this app are still issued via the
  // Facebook Login flow and don't use the Instagram refresh path.
  INSTAGRAM: instagramRefresh,
  FACEBOOK: metaRefresh,
  LINKEDIN: linkedinRefresh,
  THREADS: threadsRefresh,
};

export function getRefreshAdapter(channel) {
  return ADAPTERS[channel] ?? null;
}
