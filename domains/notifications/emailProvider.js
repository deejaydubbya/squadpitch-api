// Email provider using Resend.
// Falls back to console logging if RESEND_API_KEY is not configured.

import { env } from "../../config/env.js";

let resend = null;

async function getResend() {
  if (resend) return resend;
  if (!env.RESEND_API_KEY) return null;
  const { Resend } = await import("resend");
  resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

/**
 * Send an email via Resend.
 * @returns {{ id: string } | null} - Message ID or null if provider not configured
 */
export async function sendEmail({ to, subject, html }) {
  const client = await getResend();
  if (!client) {
    console.log(`[NOTIFICATION:EMAIL] (no provider) to=${to} subject="${subject}"`);
    return null;
  }

  const result = await client.emails.send({
    from: env.NOTIFICATION_FROM_EMAIL,
    to,
    subject,
    html,
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }

  return { id: result.data?.id };
}
