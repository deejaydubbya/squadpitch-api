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

// All activity event types.
export const ACTIVITY_EVENTS = new Set([
  ...NOTIFICATION_EVENTS,
  "DRAFT_CREATED",
  "DRAFT_APPROVED",
  "DRAFT_REJECTED",
  "DRAFT_SCHEDULED",
  "MEDIA_GENERATED",
  "CONNECTION_CONNECTED",
  // Persona analytics
  "PERSONA_CREATED",
  "PERSONA_TRAINING_STARTED",
  "PERSONA_TRAINING_COMPLETED",
  "PERSONA_TRAINING_FAILED",
  "PERSONA_USED_IN_IMAGE",
  "PERSONA_USED_IN_SMART_VIDEO",
  "PERSONA_SKIPPED",
  "PERSONA_IMAGE_APPROVED",
  "PERSONA_IMAGE_REJECTED",
  "PERSONA_MEDIA_REPLACED",
]);

export const activityTemplates = {
  // ── Notification events (also appear in activity feed) ──────────────

  POST_PUBLISHED({ channel, body, clientId }) {
    const preview = (body || "").slice(0, 80);
    return {
      title: "Post published",
      description: `${channel || "Social"} post went live: "${preview}${body?.length > 80 ? "…" : ""}"`,
      icon: "check-circle",
      linkUrl: `${APP}/workspaces/${clientId}`,
    };
  },

  POST_FAILED({ channel, publishError, clientId }) {
    return {
      title: "Post failed to publish",
      description: `${channel || "Social"} post failed: ${publishError || "unknown error"}`,
      icon: "x-circle",
      linkUrl: `${APP}/workspaces/${clientId}`,
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
      linkUrl: `${APP}/workspaces/${clientId}/settings/channels`,
    };
  },

  BATCH_COMPLETE({ count, clientId }) {
    return {
      title: "Batch generation complete",
      description: `${count} ${count === 1 ? "draft" : "drafts"} generated.`,
      icon: "layers",
      linkUrl: `${APP}/workspaces/${clientId}/library`,
    };
  },

  // ── Activity-only events ────────────────────────────────────────────

  DRAFT_CREATED({ channel, clientId }) {
    return {
      title: "Draft created",
      description: `New ${channel || "social"} draft generated.`,
      icon: "file-plus",
      linkUrl: `${APP}/workspaces/${clientId}/library`,
    };
  },

  DRAFT_APPROVED({ channel, clientId }) {
    return {
      title: "Draft approved",
      description: `${channel || "Social"} draft approved and ready to publish.`,
      icon: "thumbs-up",
      linkUrl: `${APP}/workspaces/${clientId}/library`,
    };
  },

  DRAFT_REJECTED({ channel, reason, clientId }) {
    return {
      title: "Draft rejected",
      description: reason
        ? `${channel || "Social"} draft rejected: ${reason}`
        : `${channel || "Social"} draft rejected.`,
      icon: "thumbs-down",
      linkUrl: `${APP}/workspaces/${clientId}/library`,
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
      linkUrl: `${APP}/workspaces/${clientId}/planner`,
    };
  },

  MEDIA_GENERATED({ assetType, clientId }) {
    return {
      title: "Media generated",
      description: `AI ${assetType || "image"} generation complete.`,
      icon: "image",
      linkUrl: `${APP}/workspaces/${clientId}/assets`,
    };
  },

  CONNECTION_CONNECTED({ channel, clientId }) {
    return {
      title: "Channel connected",
      description: `${channel || "Social"} channel connected successfully.`,
      icon: "plug",
      linkUrl: `${APP}/workspaces/${clientId}/settings/channels`,
    };
  },

  // ── Persona analytics ───────────────────────────────────────────────

  PERSONA_CREATED({ personaName, personaType, clientId }) {
    return {
      title: "Persona created",
      description: `${personaType === "BRAND_STYLE" ? "Brand style" : "AI"} persona "${personaName || "Untitled"}" created.`,
      icon: "user-plus",
      linkUrl: `${APP}/workspaces/${clientId}/settings/ai-persona`,
    };
  },

  PERSONA_TRAINING_STARTED({ personaName, clientId }) {
    return {
      title: "Persona training started",
      description: `Training started for "${personaName || "your persona"}".`,
      icon: "zap",
      linkUrl: `${APP}/workspaces/${clientId}/settings/ai-persona`,
    };
  },

  PERSONA_TRAINING_COMPLETED({ personaName, previewCount, clientId }) {
    return {
      title: "Persona training complete",
      description: `"${personaName || "Your persona"}" is ready${previewCount ? ` with ${previewCount} preview images` : ""}.`,
      icon: "check-circle",
      linkUrl: `${APP}/workspaces/${clientId}/settings/ai-persona`,
    };
  },

  PERSONA_TRAINING_FAILED({ personaName, error, clientId }) {
    return {
      title: "Persona training failed",
      description: `Training failed for "${personaName || "your persona"}"${error ? `: ${error}` : ""}.`,
      icon: "x-circle",
      linkUrl: `${APP}/workspaces/${clientId}/settings/ai-persona`,
    };
  },

  PERSONA_USED_IN_IMAGE({ personaType, postId, clientId }) {
    return {
      title: "Persona used in image",
      description: `${personaType === "BRAND_STYLE" ? "Brand style" : "AI"} persona applied to generated image.`,
      icon: "image",
      linkUrl: postId ? `${APP}/workspaces/${clientId}/library` : `${APP}/workspaces/${clientId}/assets`,
    };
  },

  PERSONA_USED_IN_SMART_VIDEO({ personaName, clientId }) {
    return {
      title: "Persona used in smart video",
      description: `"${personaName || "Your persona"}" used to generate video frames.`,
      icon: "video",
      linkUrl: `${APP}/workspaces/${clientId}/assets`,
    };
  },

  PERSONA_SKIPPED({ guidance, clientId }) {
    const preview = (guidance || "").slice(0, 60);
    return {
      title: "Persona skipped",
      description: `Persona was requested but skipped${preview ? ` for: "${preview}…"` : " due to content restrictions"}.`,
      icon: "slash",
      linkUrl: `${APP}/workspaces/${clientId}/assets`,
    };
  },

  PERSONA_IMAGE_APPROVED({ postId, clientId }) {
    return {
      title: "Persona image approved",
      description: "A draft with persona-generated media was approved.",
      icon: "thumbs-up",
      linkUrl: `${APP}/workspaces/${clientId}/library`,
    };
  },

  PERSONA_IMAGE_REJECTED({ feedbackReason, clientId }) {
    const reasons = {
      doesnt_look_like_me: "Doesn't look like me",
      wrong_style: "Wrong style",
      too_artificial: "Too artificial",
      not_relevant: "Not relevant",
    };
    const label = reasons[feedbackReason] || feedbackReason || "unspecified";
    return {
      title: "Persona image rejected",
      description: `Persona image rejected: ${label}.`,
      icon: "thumbs-down",
      linkUrl: `${APP}/workspaces/${clientId}/assets`,
    };
  },

  PERSONA_MEDIA_REPLACED({ personaSnapshot, clientId }) {
    return {
      title: "Persona media replaced",
      description: `Persona-generated image${personaSnapshot ? ` (${personaSnapshot})` : ""} was removed from a draft.`,
      icon: "refresh-cw",
      linkUrl: `${APP}/workspaces/${clientId}/library`,
    };
  },
};
