// Web Push provider using the web-push library.
// Falls back to console logging if VAPID keys are not configured.

import { env } from "../../../config/env.js";

let configured = false;

async function configure() {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  const webpush = await import("web-push");
  webpush.default.setVapidDetails(
    `mailto:${env.NOTIFICATION_FROM_EMAIL}`,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
}

/**
 * Send a push notification.
 * @param {{ endpoint: string, p256dh: string, auth: string, title: string, body: string, url?: string }} params
 * @returns {{ success: true }}
 */
export async function sendPush({ endpoint, p256dh, auth, title, body, url }) {
  const ready = await configure();
  if (!ready) {
    console.log(
      `[NOTIFICATION:PUSH] (no VAPID keys) title="${title}" body="${body}"`
    );
    return null;
  }

  const webpush = await import("web-push");
  const subscription = {
    endpoint,
    keys: { p256dh, auth },
  };
  const payload = JSON.stringify({ title, body, url });

  await webpush.default.sendNotification(subscription, payload);
  return { success: true };
}
