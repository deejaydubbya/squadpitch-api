// Metrics sync adapter registry.
//
// Mirrors publishing/channelAdapters/index.js — one adapter per platform.
// Each adapter exports: fetchMetrics({ connection, externalPostId }) → { raw, fetchedAt } | null

import { fetchInstagramMetrics } from "./instagram.metrics.js";
import { fetchFacebookMetrics } from "./facebook.metrics.js";
import { fetchTiktokMetrics } from "./tiktok.metrics.js";
import { fetchYoutubeMetrics } from "./youtube.metrics.js";
import { fetchXMetrics } from "./x.metrics.js";
import { fetchLinkedinMetrics } from "./linkedin.metrics.js";
import { fetchPinterestMetrics } from "./pinterest.metrics.js";

const ADAPTERS = {
  INSTAGRAM: fetchInstagramMetrics,
  FACEBOOK: fetchFacebookMetrics,
  TIKTOK: fetchTiktokMetrics,
  YOUTUBE: fetchYoutubeMetrics,
  X: fetchXMetrics,
  LINKEDIN: fetchLinkedinMetrics,
  // Org-page posts hit the same /rest/organizationalEntityShareStatistics
  // endpoint as personal-profile shares — same payload shape and same
  // post-URN parsing — so the personal adapter handles both. Token
  // scope (r_organization_social) gates whether org reads succeed.
  LINKEDIN_ORGANIZATION_PAGE: fetchLinkedinMetrics,
  // Pinterest stub — returns null until analytics scopes are added.
  PINTEREST: fetchPinterestMetrics,
};

export function getMetricsAdapterForChannel(channel) {
  const adapter = ADAPTERS[channel];
  if (!adapter) {
    throw Object.assign(
      new Error(`No metrics adapter registered for channel ${channel}`),
      { status: 400, code: "UNKNOWN_CHANNEL" }
    );
  }
  return adapter;
}
