// Notification service — the central entry point.
//
// Accepts events from across the app, checks user preferences, deduplicates,
// writes a notification_logs row (status: queued), and enqueues BullMQ jobs
// for the actual email/SMS delivery. NEVER sends inline.

import { prisma } from "../../prisma.js";
import { getNotificationQueue } from "../../lib/queues.js";

// Only these 5 event types exist.
const VALID_EVENTS = new Set([
  "POST_PUBLISHED",
  "POST_FAILED",
  "USAGE_LIMIT_NEARING",
  "CONNECTION_EXPIRED",
  "BATCH_COMPLETE",
]);

// SMS is only sent for these critical events.
const SMS_EVENTS = new Set(["POST_FAILED", "CONNECTION_EXPIRED"]);

// Deduplication window — 5 minutes.
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Get or create notification preferences for a user.
 */
export async function getPreferences(userId) {
  let prefs = await prisma.notificationPreference.findUnique({
    where: { userId },
  });
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

/**
 * Check for duplicate notification within the dedup window.
 * Returns true if a duplicate exists (should skip).
 */
async function isDuplicate(userId, eventType, resourceId) {
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
  const existing = await prisma.notificationLog.findFirst({
    where: {
      userId,
      eventType,
      resourceId: resourceId ?? null,
      createdAt: { gte: cutoff },
      status: { in: ["queued", "sent"] },
    },
    select: { id: true },
  });
  return !!existing;
}

/**
 * Enqueue a notification. This is the single entry point for the entire app.
 *
 * Does NOT send anything directly. It:
 * 1. Validates the event type
 * 2. Loads user preferences
 * 3. Checks deduplication
 * 4. Creates notification_logs rows (status: queued)
 * 5. Enqueues BullMQ jobs
 *
 * Safe to call fire-and-forget — never throws to the caller.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.eventType
 * @param {object} params.payload - Event-specific data passed to templates
 * @param {string} [params.resourceType] - e.g. "draft", "connection"
 * @param {string} [params.resourceId] - e.g. the draft ID
 */
export async function enqueueNotification({
  userId,
  eventType,
  payload,
  resourceType,
  resourceId,
}) {
  try {
    if (!VALID_EVENTS.has(eventType)) {
      console.warn(`[NOTIFICATION] Unknown event type: ${eventType}`);
      return;
    }

    // 1. Deduplication
    if (await isDuplicate(userId, eventType, resourceId)) {
      return;
    }

    // 2. Load preferences
    const prefs = await getPreferences(userId);
    const eventPrefs = prefs.preferencesJson ?? {};

    // 3. Check if this event type is enabled
    if (eventPrefs[eventType] === false) {
      return;
    }

    // 4. Get user email
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user?.email) {
      console.warn(`[NOTIFICATION] No email for user ${userId}`);
      return;
    }

    const queue = getNotificationQueue();

    // 5. Enqueue email job
    if (prefs.emailEnabled) {
      const logEntry = await prisma.notificationLog.create({
        data: {
          userId,
          eventType,
          channel: "email",
          status: "queued",
          provider: "postmark",
          resourceType: resourceType ?? null,
          resourceId: resourceId ?? null,
        },
      });

      if (queue) {
        await queue.add("send-notification-email", {
          logId: logEntry.id,
          userId,
          email: user.email,
          eventType,
          payload,
        });
      } else {
        // No queue available — mark as failed
        console.warn("[NOTIFICATION] No Redis queue — email not sent");
        await prisma.notificationLog.update({
          where: { id: logEntry.id },
          data: { status: "failed", errorMessage: "Queue unavailable" },
        });
      }
    }

    // 6. Enqueue SMS job (critical events only)
    if (
      prefs.smsEnabled &&
      prefs.phoneNumber &&
      SMS_EVENTS.has(eventType)
    ) {
      const logEntry = await prisma.notificationLog.create({
        data: {
          userId,
          eventType,
          channel: "sms",
          status: "queued",
          provider: "twilio",
          resourceType: resourceType ?? null,
          resourceId: resourceId ?? null,
        },
      });

      if (queue) {
        await queue.add("send-notification-sms", {
          logId: logEntry.id,
          userId,
          phoneNumber: prefs.phoneNumber,
          eventType,
          payload,
        });
      } else {
        console.warn("[NOTIFICATION] No Redis queue — SMS not sent");
        await prisma.notificationLog.update({
          where: { id: logEntry.id },
          data: { status: "failed", errorMessage: "Queue unavailable" },
        });
      }
    }
  } catch (err) {
    // Never crash the caller.
    console.error(`[NOTIFICATION] enqueueNotification error: ${err.message}`);
  }
}
