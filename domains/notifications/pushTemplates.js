// Push notification templates — maps event types to push payloads.
//
// Only high-value events trigger push notifications.

import { env } from "../../config/env.js";

const appUrl = env.APP_URL;

/** Event types that trigger push notifications. */
export const PUSH_EVENTS = new Set([
  "POST_FAILED",
  "CONNECTION_EXPIRED",
  "BATCH_COMPLETE",
  "POST_PUBLISHED",
]);

/**
 * Build push notification payload for a given event type.
 * @returns {{ title: string, body: string, url?: string } | null}
 */
export function buildPushPayload(eventType, payload = {}) {
  const { platformName, clientName, clientId, count, body: postBody } = payload;

  switch (eventType) {
    case "POST_FAILED":
      return {
        title: "Post failed to publish",
        body: platformName && clientName
          ? `${platformName} post for ${clientName} failed`
          : "A scheduled post failed to publish",
        url: clientId ? `${appUrl}/clients/${clientId}/library` : appUrl,
      };

    case "CONNECTION_EXPIRED":
      return {
        title: "Connection expired",
        body: platformName && clientName
          ? `${platformName} connection for ${clientName} needs re-auth`
          : "A channel connection expired and needs reconnecting",
        url: clientId ? `${appUrl}/clients/${clientId}/settings/channels` : appUrl,
      };

    case "BATCH_COMPLETE":
      return {
        title: "Batch generation complete",
        body: count
          ? `${count} posts ready for review`
          : "Your batch content is ready for review",
        url: clientId ? `${appUrl}/clients/${clientId}/library` : appUrl,
      };

    case "POST_PUBLISHED":
      return {
        title: "Post published",
        body: platformName && clientName
          ? `Published to ${platformName} for ${clientName}`
          : "A post was successfully published",
        url: clientId ? `${appUrl}/clients/${clientId}` : appUrl,
      };

    default:
      return null;
  }
}
