// Notification service — the central dispatcher.
//
// Accept event + payload → check preferences → send email/SMS → log result.
// All sends are fire-and-forget (do not block the caller).

import { prisma } from "../../prisma.js";
import { sendEmail } from "./emailProvider.js";
import { sendSms } from "./smsProvider.js";
import { templates, smsTemplates } from "./emailTemplates.js";

// Rate limiting: max 1 notification per event type per user per 10 minutes
const recentSends = new Map(); // key: `${userId}:${eventType}` → timestamp
const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes

// SMS-eligible event types (critical only)
const SMS_EVENTS = new Set(["POST_FAILED", "CONNECTION_EXPIRED"]);

/**
 * Get or create notification preferences for a user.
 */
export async function getPreferences(userId) {
  let prefs = await prisma.notificationPreference.findUnique({ where: { userId } });
  if (!prefs) {
    prefs = await prisma.notificationPreference.create({
      data: { userId },
    });
  }
  return prefs;
}

/**
 * Update notification preferences.
 */
export async function updatePreferences(userId, data) {
  return prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

/**
 * Check rate limit. Returns true if allowed.
 */
function checkRateLimit(userId, eventType) {
  const key = `${userId}:${eventType}`;
  const last = recentSends.get(key);
  if (last && Date.now() - last < RATE_LIMIT_MS) {
    return false;
  }
  recentSends.set(key, Date.now());
  // Cleanup old entries periodically
  if (recentSends.size > 10000) {
    const cutoff = Date.now() - RATE_LIMIT_MS;
    for (const [k, v] of recentSends) {
      if (v < cutoff) recentSends.delete(k);
    }
  }
  return true;
}

/**
 * Log a notification attempt.
 */
async function logNotification(userId, eventType, channel, status, payload, error) {
  try {
    await prisma.notificationLog.create({
      data: {
        userId,
        eventType,
        channel,
        status,
        payload: payload ?? undefined,
        error: error ?? undefined,
      },
    });
  } catch (err) {
    console.error("[NOTIFICATION] Failed to log:", err.message);
  }
}

/**
 * Send a notification for a given event.
 *
 * This function is designed to be called fire-and-forget. It never throws
 * to the caller — all errors are caught and logged.
 *
 * @param {object} params
 * @param {string} params.userId - The user to notify
 * @param {string} params.eventType - One of the event type constants
 * @param {object} params.payload - Event-specific data passed to templates
 */
export async function sendNotification({ userId, eventType, payload }) {
  try {
    // 1. Rate limit
    if (!checkRateLimit(userId, eventType)) {
      return;
    }

    // 2. Load preferences
    const prefs = await getPreferences(userId);
    const eventPrefs = prefs.preferences ?? {};

    // 3. Check if this event type is enabled
    if (eventPrefs[eventType] === false) {
      return;
    }

    // 4. Get user email
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) {
      console.warn(`[NOTIFICATION] No email for user ${userId}`);
      return;
    }

    // 5. Send email
    if (prefs.emailEnabled) {
      const templateFn = templates[eventType];
      if (templateFn) {
        const { subject, html } = templateFn(payload);
        try {
          await sendEmail({ to: user.email, subject, html });
          await logNotification(userId, eventType, "email", "SENT", payload);
        } catch (err) {
          console.error(`[NOTIFICATION:EMAIL] Failed: ${err.message}`);
          await logNotification(userId, eventType, "email", "FAILED", payload, err.message);
        }
      }
    }

    // 6. Send SMS (critical events only)
    if (prefs.smsEnabled && prefs.phone && SMS_EVENTS.has(eventType)) {
      const smsFn = smsTemplates[eventType];
      if (smsFn) {
        const body = smsFn(payload);
        try {
          await sendSms({ to: prefs.phone, body });
          await logNotification(userId, eventType, "sms", "SENT", payload);
        } catch (err) {
          console.error(`[NOTIFICATION:SMS] Failed: ${err.message}`);
          await logNotification(userId, eventType, "sms", "FAILED", payload, err.message);
        }
      }
    }
  } catch (err) {
    // Never crash the caller
    console.error(`[NOTIFICATION] Unexpected error: ${err.message}`);
  }
}

/**
 * Get notification logs for a user.
 */
export async function getNotificationLogs(userId, { limit = 50, offset = 0 } = {}) {
  return prisma.notificationLog.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });
}
