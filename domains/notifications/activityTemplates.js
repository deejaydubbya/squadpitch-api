// Activity event templates.
// Maps all event types to { title, description, icon }.

import { env } from "../../config/env.js";

const APP = env.APP_URL || "https://squadpitch-web.fly.dev";

// The 5 events that also trigger bell notifications.
export const NOTIFICATION_EVENTS = new Set([
  "POST_PUBLISHED",
  "POST_FAILED",
  "USAGE_LIMIT_NEARING",
  "CONNECTION_EXPIRED",
  "BATCH_COMPLETE",
]);

// All 11 activity event types.
export const ACTIVITY_EVENTS = new Set([
  ...NOTIFICATION_EVENTS,
  "DRAFT_CREATED",
  "DRAFT_APPROVED",
  "DRAFT_REJECTED",
  "DRAFT_SCHEDULED",
  "MEDIA_GENERATED",
  "CONNECTION_CONNECTED",
]);

export const activityTemplates = {
  // ── Notification events (also appear in activity feed) ──────────────

  POST_PUBLISHED({ channel, body, clientId }) {
    const preview = (body || "").slice(0, 80);
    return {
      title: "Post published",
      description: `${channel || "Social"} post went live: "${preview}${body?.length > 80 ? "…" : ""}"`,
      icon: "check-circle",
      linkUrl: `${APP}/clients/${clientId}`,
    };
  },

  POST_FAILED({ channel, publishError, clientId }) {
    return {
      title: "Post failed to publish",
      description: `${channel || "Social"} post failed: ${publishError || "unknown error"}`,
      icon: "x-circle",
      linkUrl: `${APP}/clients/${clientId}`,
    };
  },

  USAGE_LIMIT_NEARING({ metric, used, limit }) {
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
    return {
      title: "Usage limit approaching",
      description: `${pct}% of monthly ${metric} limit used (${used}/${limit}).`,
      icon: "alert-triangle",
      linkUrl: `${APP}/dashboard`,
    };
  },

  CONNECTION_EXPIRED({ channel, clientId }) {
    return {
      title: "Channel disconnected",
      description: `${channel || "Social"} connection expired.`,
      icon: "unplug",
      linkUrl: `${APP}/clients/${clientId}/settings/channels`,
    };
  },

  BATCH_COMPLETE({ count, clientId }) {
    return {
      title: "Batch generation complete",
      description: `${count} ${count === 1 ? "draft" : "drafts"} generated.`,
      icon: "layers",
      linkUrl: `${APP}/clients/${clientId}/library`,
    };
  },

  // ── Activity-only events ────────────────────────────────────────────

  DRAFT_CREATED({ channel, clientId }) {
    return {
      title: "Draft created",
      description: `New ${channel || "social"} draft generated.`,
      icon: "file-plus",
      linkUrl: `${APP}/clients/${clientId}/library`,
    };
  },

  DRAFT_APPROVED({ channel, clientId }) {
    return {
      title: "Draft approved",
      description: `${channel || "Social"} draft approved and ready to publish.`,
      icon: "thumbs-up",
      linkUrl: `${APP}/clients/${clientId}/library`,
    };
  },

  DRAFT_REJECTED({ channel, reason, clientId }) {
    return {
      title: "Draft rejected",
      description: reason
        ? `${channel || "Social"} draft rejected: ${reason}`
        : `${channel || "Social"} draft rejected.`,
      icon: "thumbs-down",
      linkUrl: `${APP}/clients/${clientId}/library`,
    };
  },

  DRAFT_SCHEDULED({ channel, scheduledFor, clientId }) {
    const when = scheduledFor
      ? new Date(scheduledFor).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
      : "a future date";
    return {
      title: "Draft scheduled",
      description: `${channel || "Social"} draft scheduled for ${when}.`,
      icon: "calendar-clock",
      linkUrl: `${APP}/clients/${clientId}/planner`,
    };
  },

  MEDIA_GENERATED({ assetType, clientId }) {
    return {
      title: "Media generated",
      description: `AI ${assetType || "image"} generation complete.`,
      icon: "image",
      linkUrl: `${APP}/clients/${clientId}/assets`,
    };
  },

  CONNECTION_CONNECTED({ channel, clientId }) {
    return {
      title: "Channel connected",
      description: `${channel || "Social"} channel connected successfully.`,
      icon: "plug",
      linkUrl: `${APP}/clients/${clientId}/settings/channels`,
    };
  },
};
