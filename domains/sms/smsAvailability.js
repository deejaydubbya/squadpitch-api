import { captureException } from "../../lib/sentry.js";

export const SMS_AVAILABILITY = Object.freeze({
  status: "unavailable",
  availability: "disabled",
  reason: "twilio_account_suspended",
  customerMessage: "SMS is temporarily unavailable.",
});

export class SmsUnavailableError extends Error {
  constructor() {
    super(SMS_AVAILABILITY.customerMessage);
    this.name = "SmsUnavailableError";
    this.code = "SMS_UNAVAILABLE";
    this.status = 503;
  }
}

const reported = new Map();
const COOLDOWN_MS = 15 * 60_000;

export function assertSmsAvailable() {
  throw new SmsUnavailableError();
}

export function recordBlockedSmsAttempt(surface) {
  const safeSurface = new Set([
    "outbound",
    "inbound",
    "status",
    "job",
    "ai",
  ]).has(surface)
    ? surface
    : "unknown";
  const now = Date.now();
  if (now - (reported.get(safeSurface) ?? 0) < COOLDOWN_MS) return;
  reported.set(safeSurface, now);
  const error = Object.assign(
    new Error("Blocked SMS attempt while unavailable"),
    {
      code: "SMS_UNAVAILABLE",
    },
  );
  captureException(error, {
    source: "sms-disabled",
    surface: safeSurface,
    status: SMS_AVAILABILITY.status,
    reason: SMS_AVAILABILITY.reason,
  });
}
