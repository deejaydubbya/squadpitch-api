export const UPSTASH_STORAGE_LIMIT_BYTES = 250 * 1024 * 1024;
export const STORAGE_THRESHOLDS = Object.freeze([0.5, 0.7, 0.85]);

export const QUEUE_ALLOWLIST = Object.freeze([
  "sp-worker-health",
  "sp-scheduled-publish",
  "sp-media-gen",
  "sp-video-gen",
  "sp-notification",
  "sp-weekly-digest",
  "sp-metrics-sync",
  "sp-analytics-recalc",
  "sp-insights-refresh",
  "sp-persona-training",
  "sp-gbp-review-poll",
  "sp-youtube-comment-poll",
  "sp-threads-reply-poll",
  "sp-facebook-comments-poll",
  "sp-instagram-comments-poll",
  "sp-autopilot-evaluator",
  "sp-contact-retention",
]);

export function classifyStorage(usedBytes) {
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) {
    return {
      usedBytes: null,
      limitBytes: UPSTASH_STORAGE_LIMIT_BYTES,
      utilization: null,
      warningThreshold: null,
      status: "provider_metric_unavailable",
    };
  }
  const utilization = usedBytes / UPSTASH_STORAGE_LIMIT_BYTES;
  const crossed = STORAGE_THRESHOLDS.filter((threshold) => utilization >= threshold);
  return {
    usedBytes,
    limitBytes: UPSTASH_STORAGE_LIMIT_BYTES,
    utilization,
    warningThreshold: crossed.length ? crossed.at(-1) : null,
    status:
      utilization >= 0.85
        ? "critical"
        : utilization >= 0.7
          ? "warning"
          : utilization >= 0.5
            ? "notice"
            : "ok",
  };
}

export function parseUsedMemory(info) {
  const match = /^used_memory:(\d+)$/m.exec(info);
  if (!match) throw new Error("Redis INFO did not include used_memory");
  const value = Number(match[1]);
  return value > 0 ? value : null;
}
