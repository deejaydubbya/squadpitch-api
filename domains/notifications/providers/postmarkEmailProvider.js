// Email provider using Postmark.
// Falls back to console logging if POSTMARK_SERVER_TOKEN is not configured.

import { env } from "../../../config/env.js";

let client = null;

async function getClient() {
  if (client) return client;
  if (!env.POSTMARK_SERVER_TOKEN) return null;
  const postmark = await import("postmark");
  client = new postmark.ServerClient(env.POSTMARK_SERVER_TOKEN);
  return client;
}

/**
 * Send an email via Postmark.
 * @returns {{ messageId: string } | null}
 */
export async function sendEmail({ to, subject, html }) {
  const pm = await getClient();
  if (!pm) {
    console.log(
      `[NOTIFICATION:EMAIL] (no provider) to=${to} subject="${subject}"`
    );
    return null;
  }

  const result = await pm.sendEmail({
    From: env.NOTIFICATION_FROM_EMAIL,
    To: to,
    Subject: subject,
    HtmlBody: html,
    MessageStream: "outbound",
  });

  return { messageId: result.MessageID };
}
