// Unified notification dispatcher — the central entry point.
//
// Accepts events from across the app and fans out to all 6 channels:
//   1. In-app notifications (always)
//   2. Activity feed (always)
//   3. Email (if enabled + event enabled)
//   4. SMS (if enabled + critical events only)
//   5. Push (if enabled + high-value events)
//   6. Slack (if connected + event subscribed)
//   7. Webhooks (if configured + event subscribed)
//
// Checks user preferences, deduplicates, and enqueues BullMQ jobs.
// NEVER sends inline. Never throws to the caller.

import { prisma } from "../../prisma.js";
import { getNotificationQueue } from "../../lib/queues.js";
import { inAppTemplates } from "./inAppTemplates.js";
import { activityTemplates, NOTIFICATION_EVENTS, ACTIVITY_EVENTS } from "./activityTemplates.js";
import { PUSH_EVENTS, buildPushPayload } from "./pushTemplates.js";
import { dispatchEvent as dispatchIntegrationEvent } from "../integrations/integration.service.js";

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

    // 2. Load preferences (needed for per-channel gating below)
    const prefs = await getPreferences(userId);
    const eventPrefs = prefs.preferencesJson ?? {};

    // 3. Create in-app notification (unless user disabled this event for in-app)
    const inAppKey = `INAPP_${eventType}`;
    if (eventPrefs[inAppKey] !== false) {
      createInAppNotification({ userId, eventType, payload, resourceType, resourceId }).catch((e) =>
        console.error(`[NOTIFICATION] in-app create error: ${e.message}`)
      );
    }

    // 4. Always create activity event (audit trail, not user-dismissable)
    createActivityEvent({ userId, clientId: payload?.clientId, eventType, payload, resourceType, resourceId }).catch((e) =>
      console.error(`[NOTIFICATION] activity create error: ${e.message}`)
    );

    // 5. Check if this event type is globally disabled (skips email/SMS/push/slack/webhook)
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

    // 7. Enqueue push jobs (high-value events, if user has push enabled)
    if (prefs.pushEnabled && PUSH_EVENTS.has(eventType)) {
      const pushPrefKey = `PUSH_${eventType}`;
      if (eventPrefs[pushPrefKey] !== false) {
        enqueuePushNotifications({ userId, eventType, payload }).catch((e) =>
          console.error(`[NOTIFICATION] push enqueue error: ${e.message}`)
        );
      }
    }

    // 8. Dispatch to all integrations (Slack, Webhooks, future types)
    dispatchToIntegrations({ userId, eventType, payload });
  } catch (err) {
    // Never crash the caller.
    console.error(`[NOTIFICATION] enqueueNotification error: ${err.message}`);
  }
}

// ── In-app notifications ───────────────────────────────────────────────

async function createInAppNotification({ userId, eventType, payload, resourceType, resourceId }) {
  const templateFn = inAppTemplates[eventType];
  if (!templateFn) return;
  const { title, message, linkUrl } = templateFn(payload || {});
  await prisma.notification.create({
    data: {
      userId,
      eventType,
      title,
      message,
      linkUrl,
      resourceType: resourceType ?? null,
      resourceId: resourceId ?? null,
      metadata: payload ?? undefined,
    },
  });
}

async function createActivityEvent({ userId, clientId, eventType, payload, resourceType, resourceId }) {
  const templateFn = activityTemplates[eventType];
  if (!templateFn) return;
  const { title, description, icon, linkUrl } = templateFn(payload || {});
  await prisma.activityEvent.create({
    data: {
      userId,
      clientId: clientId ?? null,
      eventType,
      title,
      description,
      icon,
      linkUrl,
      resourceType: resourceType ?? null,
      resourceId: resourceId ?? null,
      metadata: payload ?? undefined,
    },
  });
}

/**
 * Record an activity-only event (no bell notification).
 * For events like DRAFT_CREATED, DRAFT_APPROVED, etc.
 * Safe to call fire-and-forget.
 */
export async function recordActivity({ userId, clientId, eventType, payload, resourceType, resourceId }) {
  try {
    if (!ACTIVITY_EVENTS.has(eventType)) {
      console.warn(`[ACTIVITY] Unknown event type: ${eventType}`);
      return;
    }
    await createActivityEvent({ userId, clientId, eventType, payload, resourceType, resourceId });
  } catch (err) {
    console.error(`[ACTIVITY] recordActivity error: ${err.message}`);
  }
}

// ── Inbox queries ──────────────────────────────────────────────────────

export async function getInboxNotifications(userId, { limit = 20, offset = 0, filter = "all" } = {}) {
  const where = { userId };
  if (filter === "unread") where.read = false;
  else if (filter === "read") where.read = true;

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.notification.count({ where }),
  ]);

  return { notifications, total };
}

export async function getUnreadCount(userId) {
  return prisma.notification.count({
    where: { userId, read: false },
  });
}

export async function markAsRead(userId, notificationId) {
  return prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { read: true },
  });
}

export async function markAllAsRead(userId) {
  return prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

// ── Push subscriptions ────────────────────────────────────────────────

async function enqueuePushNotifications({ userId, eventType, payload }) {
  const subs = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { endpoint: true, p256dh: true, auth: true },
  });
  if (!subs.length) return;

  const pushPayload = buildPushPayload(eventType, payload);
  if (!pushPayload) return;

  const queue = getNotificationQueue();
  if (!queue) {
    console.warn("[NOTIFICATION] No Redis queue — push not sent");
    return;
  }

  for (const sub of subs) {
    await queue.add("send-notification-push", {
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      title: pushPayload.title,
      body: pushPayload.body,
      url: pushPayload.url,
    });
  }
}

export async function subscribePush(userId, { endpoint, p256dh, auth, userAgent }) {
  await prisma.pushSubscription.upsert({
    where: { userId_endpoint: { userId, endpoint } },
    create: { userId, endpoint, p256dh, auth, userAgent: userAgent ?? null },
    update: { p256dh, auth, userAgent: userAgent ?? null },
  });
  // Also enable pushEnabled on preferences
  await prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, pushEnabled: true },
    update: { pushEnabled: true },
  });
}

export async function unsubscribePush(userId, endpoint) {
  await prisma.pushSubscription.deleteMany({
    where: { userId, endpoint },
  });
  // If no subscriptions remain, disable pushEnabled
  const remaining = await prisma.pushSubscription.count({ where: { userId } });
  if (remaining === 0) {
    await prisma.notificationPreference.updateMany({
      where: { userId },
      data: { pushEnabled: false },
    });
  }
}

export async function getPushSubscriptions(userId) {
  return prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, userAgent: true, createdAt: true },
  });
}

// ── Integration dispatch ──────────────────────────────────────────────

function dispatchToIntegrations({ userId, eventType, payload }) {
  dispatchIntegrationEvent({ userId, eventType, payload }).catch((e) =>
    console.error(`[NOTIFICATION] integration dispatch error: ${e.message}`)
  );
}

// ── Activity feed ──────────────────────────────────────────────────────

export async function getActivityFeed(userId, { limit = 20, offset = 0, clientId } = {}) {
  const where = { userId };
  if (clientId) where.clientId = clientId;

  const [events, total] = await Promise.all([
    prisma.activityEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.activityEvent.count({ where }),
  ]);

  return { events, total };
}
