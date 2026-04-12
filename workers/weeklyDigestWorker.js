// BullMQ recurring worker — weekly digest emails.
//
// Runs every Monday at 8:00 AM UTC.
// For each user with digestEnabled, aggregates past-week stats
// across all their clients and sends a summary email.

import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { prisma } from "../prisma.js";
import { sendEmail } from "../domains/notifications/providers/postmarkEmailProvider.js";
import { buildDigestEmail } from "../domains/notifications/digestTemplate.js";

const QUEUE_NAME = "sp-weekly-digest";

async function processTick() {
  console.log("[DIGEST] Starting weekly digest run…");

  // 1. Find all users with digest enabled
  const prefs = await prisma.notificationPreference.findMany({
    where: { digestEnabled: true, emailEnabled: true },
    select: { userId: true },
  });

  if (!prefs.length) {
    console.log("[DIGEST] No users with digest enabled, skipping.");
    return;
  }

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const periodLabel = `${weekAgo.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  let sent = 0;
  let skipped = 0;

  for (const { userId } of prefs) {
    try {
      await processUserDigest(userId, weekAgo, now, periodLabel);
      sent++;
    } catch (err) {
      skipped++;
      console.error(`[DIGEST] Error for user ${userId}: ${err.message}`);
    }
  }

  console.log(`[DIGEST] Complete: ${sent} sent, ${skipped} skipped.`);
}

async function processUserDigest(userId, since, until, periodLabel) {
  // Get user
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true },
  });
  if (!user?.email) return;

  // Get all active clients owned by this user
  const clients = await prisma.client.findMany({
    where: { createdBy: userId, status: "ACTIVE" },
    select: { id: true, name: true },
  });

  if (!clients.length) return;

  const clientIds = clients.map((c) => c.id);

  // Aggregate stats across all clients
  const [published, scheduled, failed] = await Promise.all([
    prisma.draft.count({
      where: {
        clientId: { in: clientIds },
        status: "PUBLISHED",
        publishedAt: { gte: since, lt: until },
      },
    }),
    prisma.draft.count({
      where: {
        clientId: { in: clientIds },
        status: "SCHEDULED",
        scheduledFor: { gte: until },
      },
    }),
    prisma.draft.count({
      where: {
        clientId: { in: clientIds },
        status: "FAILED",
        updatedAt: { gte: since, lt: until },
      },
    }),
  ]);

  // Skip if zero activity
  if (published === 0 && scheduled === 0 && failed === 0) return;

  // Get metrics for published posts
  const metrics = await prisma.postMetrics.aggregate({
    where: {
      clientId: { in: clientIds },
      draft: { status: "PUBLISHED", publishedAt: { gte: since, lt: until } },
    },
    _sum: { impressions: true, engagement: true },
  });

  // Find top post by engagement
  const topPostMetric = await prisma.postMetrics.findFirst({
    where: {
      clientId: { in: clientIds },
      draft: { status: "PUBLISHED", publishedAt: { gte: since, lt: until } },
      engagement: { gt: 0 },
    },
    orderBy: { engagement: "desc" },
    include: { draft: { select: { body: true, channel: true, clientId: true } } },
  });

  const topPost = topPostMetric
    ? {
        channel: topPostMetric.draft.channel,
        body: topPostMetric.draft.body,
        engagement: topPostMetric.engagement,
      }
    : null;

  const { subject, html } = buildDigestEmail({
    userName: user.name?.split(" ")[0] || null,
    periodLabel,
    postsPublished: published,
    postsScheduled: scheduled,
    postsFailed: failed,
    totalImpressions: metrics._sum.impressions || 0,
    totalEngagement: metrics._sum.engagement || 0,
    topPost,
    clientId: clients.length === 1 ? clients[0].id : null,
  });

  await sendEmail({ to: user.email, subject, html });
}

// ── Worker bootstrap ──────────────────────────────────────────────────

export function startWeeklyDigestWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[DIGEST] No Redis — weekly digest worker disabled");
    return null;
  }

  const queue = new Queue(QUEUE_NAME, { connection });

  // Seed repeating job — every Monday at 8:00 AM UTC
  queue.add("run-weekly-digest", {}, {
    repeat: { pattern: "0 8 * * 1" },
  });

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await processTick();
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[DIGEST] job ${job?.id} failed:`, err?.message ?? err);
  });
  worker.on("error", (err) => {
    console.error("[DIGEST] worker error:", err?.message ?? err);
  });

  console.log("[DIGEST] sp-weekly-digest worker started");

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
