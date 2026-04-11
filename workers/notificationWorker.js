// BullMQ worker for Squadpitch notification delivery.
//
// Queue: "sp-notification", concurrency: 5.
//
// Handles two job types:
//   send-notification-email  → Postmark
//   send-notification-sms    → Twilio
//
// On success: updates notification_logs status → "sent", stores providerMessageId.
// On failure: updates notification_logs status → "failed", stores errorMessage.

import { Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { prisma } from "../prisma.js";
import { sendEmail } from "../domains/notifications/providers/postmarkEmailProvider.js";
import { sendSms } from "../domains/notifications/providers/twilioSmsProvider.js";
import { templates, smsTemplates } from "../domains/notifications/emailTemplates.js";

async function processJob(job) {
  const { name, data } = job;

  if (name === "send-notification-email") {
    return processEmailJob(data);
  }

  if (name === "send-notification-sms") {
    return processSmsJob(data);
  }

  throw new Error(`Unknown notification job type: ${name}`);
}

async function processEmailJob({ logId, email, eventType, payload }) {
  const templateFn = templates[eventType];
  if (!templateFn) {
    await markFailed(logId, `No email template for event: ${eventType}`);
    // Don't throw — no point retrying a missing template.
    return { skipped: true };
  }

  const { subject, html } = templateFn(payload);

  try {
    const result = await sendEmail({ to: email, subject, html });
    await prisma.notificationLog.update({
      where: { id: logId },
      data: {
        status: "sent",
        providerMessageId: result?.messageId ?? null,
      },
    });
    return { sent: true, messageId: result?.messageId };
  } catch (err) {
    await markFailed(logId, err?.message ?? "Email send failed");
    throw err; // Re-throw so BullMQ retries transient failures.
  }
}

async function processSmsJob({ logId, phoneNumber, eventType, payload }) {
  const smsFn = smsTemplates[eventType];
  if (!smsFn) {
    await markFailed(logId, `No SMS template for event: ${eventType}`);
    return { skipped: true };
  }

  const body = smsFn(payload);

  try {
    const result = await sendSms({ to: phoneNumber, body });
    await prisma.notificationLog.update({
      where: { id: logId },
      data: {
        status: "sent",
        providerMessageId: result?.sid ?? null,
      },
    });
    return { sent: true, sid: result?.sid };
  } catch (err) {
    await markFailed(logId, err?.message ?? "SMS send failed");
    throw err;
  }
}

async function markFailed(logId, errorMessage) {
  try {
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: "failed", errorMessage },
    });
  } catch {
    // Best-effort — don't crash if log update fails.
  }
}

export function startNotificationWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn(
      "[WORKER] No Redis connection — sp-notification worker disabled"
    );
    return null;
  }

  const worker = new Worker("sp-notification", processJob, {
    connection,
    concurrency: 5,
  });

  worker.on("completed", (job) => {
    console.log(
      `[WORKER] sp-notification job ${job.id} (${job.name}) completed`
    );
  });
  worker.on("failed", (job, err) => {
    console.error(
      `[WORKER] sp-notification job ${job?.id} (${job?.name}) failed:`,
      err?.message ?? err
    );
  });
  worker.on("error", (err) => {
    console.error(
      "[WORKER] sp-notification worker error:",
      err?.message ?? err
    );
  });

  console.log("[WORKER] sp-notification worker started");
  return worker;
}
