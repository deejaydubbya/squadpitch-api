// SMS provider using Twilio.
// Falls back to console logging if Twilio credentials are not configured.

import { env } from "../../../config/env.js";

let twilioClient = null;

async function getTwilio() {
  if (twilioClient) return twilioClient;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  const twilio = await import("twilio");
  twilioClient = twilio.default(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return twilioClient;
}

/**
 * Send an SMS via Twilio.
 * @returns {{ sid: string } | null}
 */
export async function sendSms({ to, body }) {
  const client = await getTwilio();
  if (!client || !env.TWILIO_FROM_NUMBER) {
    console.log(`[NOTIFICATION:SMS] (no provider) to=${to} body="${body}"`);
    return null;
  }

  const message = await client.messages.create({
    body,
    from: env.TWILIO_FROM_NUMBER,
    to,
  });

  return { sid: message.sid };
}
