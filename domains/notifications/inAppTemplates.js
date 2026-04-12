// In-app notification templates.
// Maps the 5 notification event types to { title, message, linkUrl }.

import { env } from "../../config/env.js";

const APP = env.APP_URL || "https://squadpitch-web.fly.dev";

export const inAppTemplates = {
  POST_PUBLISHED({ channel, body, clientId }) {
    const preview = (body || "").slice(0, 120);
    return {
      title: "Post published",
      message: `Your ${channel || "social"} post is live: "${preview}${body?.length > 120 ? "…" : ""}"`,
      linkUrl: `${APP}/clients/${clientId}`,
    };
  },

  POST_FAILED({ channel, publishError, clientId, draftId }) {
    return {
      title: "Post failed to publish",
      message: `Your ${channel || "social"} post failed: ${publishError || "unknown error"}`,
      linkUrl: draftId ? `${APP}/clients/${clientId}/library` : `${APP}/clients/${clientId}`,
    };
  },

  USAGE_LIMIT_NEARING({ metric, used, limit }) {
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
    return {
      title: "Usage limit approaching",
      message: `You've used ${pct}% of your monthly ${metric} limit (${used}/${limit}).`,
      linkUrl: `${APP}/dashboard`,
    };
  },

  CONNECTION_EXPIRED({ channel, clientId }) {
    return {
      title: "Channel disconnected",
      message: `Your ${channel || "social"} connection has expired. Reconnect to keep publishing.`,
      linkUrl: `${APP}/clients/${clientId}/settings/channels`,
    };
  },

  BATCH_COMPLETE({ count, clientId }) {
    return {
      title: "Batch generation complete",
      message: `${count} ${count === 1 ? "draft" : "drafts"} have been generated and are ready for review.`,
      linkUrl: `${APP}/clients/${clientId}/library`,
    };
  },
};
