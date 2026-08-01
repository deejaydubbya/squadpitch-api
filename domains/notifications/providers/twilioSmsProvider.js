// SMS provider using Twilio.
// Falls back to console logging if Twilio credentials are not configured.

import { env } from "../../../config/env.js";
import {
  assertSmsAvailable,
  recordBlockedSmsAttempt,
} from "../../sms/smsAvailability.js";

let twilioClient = null;

async function getTwilio() {
  if (twilioClient) return twilioClient;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.warn("[TWILIO] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    return null;
  }
  try {
    const twilio = await import("twilio");
    twilioClient = twilio.default(
      env.TWILIO_ACCOUNT_SID,
      env.TWILIO_AUTH_TOKEN,
    );
    return twilioClient;
  } catch (err) {
    console.error(`[TWILIO] Failed to initialize client: ${err.message}`);
    return null;
  }
}

/**
 * Send an SMS via Twilio.
 * @returns {{ sid: string } | null}
 */
export async function sendSms({ to, body }) {
  recordBlockedSmsAttempt("outbound");
  assertSmsAvailable();
  if (!env.SMS_SENDING_ENABLED || !env.SMS_A2P_APPROVED) {
    return null;
  }
  const client = await getTwilio();
  if (!client || !env.TWILIO_MESSAGING_SERVICE_SID) {
    console.warn("[TWILIO] SMS provider is unavailable");
    return null;
  }

  const message = await client.messages.create({
    body,
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    to,
    ...(env.TWILIO_STATUS_CALLBACK_URL
      ? { statusCallback: env.TWILIO_STATUS_CALLBACK_URL }
      : {}),
  });

  if (typeof message?.sid !== "string" || !message.sid) {
    const error = new Error("Twilio did not return a message SID");
    error.code = "TWILIO_INVALID_RESPONSE";
    throw error;
  }
  return { sid: message.sid, status: message.status ?? null };
}
