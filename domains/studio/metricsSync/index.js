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

const ADAPTERS = {
  INSTAGRAM: fetchInstagramMetrics,
  FACEBOOK: fetchFacebookMetrics,
  TIKTOK: fetchTiktokMetrics,
  YOUTUBE: fetchYoutubeMetrics,
  X: fetchXMetrics,
  LINKEDIN: fetchLinkedinMetrics,
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
