// BullMQ worker for Squadpitch notification delivery.
//
// Queue: "sp-notification", concurrency: 5.
//
// Handles seven job types:
//   send-notification-email    → Postmark
//   send-notification-sms      → Twilio
//   send-notification-push     → Web Push (VAPID)
//   send-notification-slack    → Slack incoming webhook
//   send-notification-webhook  → Outbound webhook (HMAC-signed)
//   send-integration-notion    → Notion page creation
//   send-integration-sheets    → Google Sheets row append
//   send-integration-hubspot   → HubSpot CRM activity logging
//   send-integration-mailchimp → Mailchimp draft campaign creation
//   send-integration-convertkit→ ConvertKit draft broadcast creation
//   send-integration-wordpress → WordPress draft post creation
//   send-integration-webflow   → Webflow draft CMS item creation
//
// On success: updates notification_logs status → "sent", stores providerMessageId.
// On failure: updates notification_logs status → "failed", stores errorMessage.

import { Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { prisma } from "../prisma.js";
import { sendEmail } from "../domains/notifications/providers/postmarkEmailProvider.js";
import { sendSms } from "../domains/notifications/providers/twilioSmsProvider.js";
import { sendPush } from "../domains/notifications/providers/webPushProvider.js";
import { sendSlackNotification } from "../domains/notifications/providers/slackWebhookProvider.js";
import { deliverWebhook } from "../domains/notifications/providers/webhookProvider.js";
import { templates, smsTemplates } from "../domains/notifications/emailTemplates.js";
import { createNotionPage } from "../domains/integrations/providers/notionProvider.js";
import { appendSheetRow } from "../domains/integrations/providers/sheetsProvider.js";
import { sendDiscordNotification } from "../domains/integrations/providers/discordProvider.js";
import { logActivity as logHubspotActivity } from "../domains/integrations/providers/hubspotProvider.js";
import { createDraftCampaign } from "../domains/integrations/providers/mailchimpProvider.js";
import { createDraftBroadcast } from "../domains/integrations/providers/convertkitProvider.js";
import { createDraftPost } from "../domains/integrations/providers/wordpressProvider.js";
import { createDraftItem } from "../domains/integrations/providers/webflowProvider.js";

async function processJob(job) {
  const { name, data } = job;

  if (name === "send-notification-email") {
    return processEmailJob(data);
  }

  if (name === "send-notification-sms") {
    return processSmsJob(data);
  }

  if (name === "send-notification-push") {
    return processPushJob(data);
  }

  if (name === "send-notification-slack") {
    return processSlackJob(data);
  }

  if (name === "send-notification-webhook") {
    return processWebhookJob(data);
  }

  if (name === "send-integration-notion") {
    return processNotionJob(data);
  }

  if (name === "send-integration-sheets") {
    return processSheetsJob(data);
  }

  if (name === "send-integration-discord") {
    return processDiscordJob(data);
  }

  if (name === "send-integration-hubspot") {
    return processHubspotJob(data);
  }

  if (name === "send-integration-mailchimp") {
    return processMailchimpJob(data);
  }

  if (name === "send-integration-convertkit") {
    return processConvertkitJob(data);
  }

  if (name === "send-integration-wordpress") {
    return processWordpressJob(data);
  }

  if (name === "send-integration-webflow") {
    return processWebflowJob(data);
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

async function processPushJob({ endpoint, p256dh, auth, title, body, url }) {
  try {
    await sendPush({ endpoint, p256dh, auth, title, body, url });
    return { sent: true };
  } catch (err) {
    const statusCode = err?.statusCode ?? err?.status;
    // 410 Gone or 404 = subscription expired or unsubscribed — clean up
    if (statusCode === 410 || statusCode === 404) {
      try {
        await prisma.pushSubscription.deleteMany({ where: { endpoint } });
        console.log(`[WORKER] Removed expired push subscription: ${endpoint.slice(0, 60)}…`);
      } catch {
        // Best-effort cleanup
      }
      return { expired: true };
    }
    // Other errors — re-throw for BullMQ retry
    throw err;
  }
}

async function processSlackJob({ webhookUrl, eventType, payload }) {
  try {
    await sendSlackNotification(webhookUrl, eventType, payload);
    return { sent: true };
  } catch (err) {
    // Re-throw for BullMQ retry on transient failures
    throw err;
  }
}

async function processWebhookJob({ webhookId, targetUrl, secret, eventType, payload, userId }) {
  // Create delivery log
  let logId;
  try {
    const log = await prisma.webhookDeliveryLog.create({
      data: {
        webhookId,
        eventType,
        requestBody: payload,
        status: "pending",
      },
    });
    logId = log.id;
  } catch {
    // Best-effort logging
  }

  try {
    const { responseStatus, responseBody } = await deliverWebhook({
      targetUrl,
      secret,
      eventType,
      payload,
      userId,
    });

    const success = responseStatus >= 200 && responseStatus < 300;

    if (logId) {
      await prisma.webhookDeliveryLog.update({
        where: { id: logId },
        data: {
          responseStatus,
          responseBody,
          status: success ? "success" : "failed",
          attemptCount: { increment: 1 },
        },
      }).catch(() => {});
    }

    if (!success) {
      throw new Error(`Webhook returned ${responseStatus}`);
    }

    return { sent: true, responseStatus };
  } catch (err) {
    if (logId) {
      await prisma.webhookDeliveryLog.update({
        where: { id: logId },
        data: {
          status: "failed",
          attemptCount: { increment: 1 },
        },
      }).catch(() => {});
    }
    throw err; // Re-throw for retry
  }
}

async function processNotionJob({ integrationId, config, eventType, payload }) {
  try {
    const result = await createNotionPage(config, eventType, payload);
    await updateIntegrationLog(integrationId, eventType, "success", result);
    return { sent: true, pageId: result.pageId };
  } catch (err) {
    await updateIntegrationLog(integrationId, eventType, "failed", null, err.message);
    throw err; // Re-throw for BullMQ retry
  }
}

async function processSheetsJob({ integrationId, config, eventType, payload }) {
  try {
    const result = await appendSheetRow(config, eventType, payload);
    await updateIntegrationLog(integrationId, eventType, "success", result);
    return { sent: true, updatedRange: result.updatedRange };
  } catch (err) {
    await updateIntegrationLog(integrationId, eventType, "failed", null, err.message);
    throw err; // Re-throw for BullMQ retry
  }
}

async function processDiscordJob({ integrationId, config, eventType, payload }) {
  try {
    const result = await sendDiscordNotification(config, eventType, payload);
    await updateIntegrationLog(integrationId, eventType, "success", result);
    return { sent: true };
  } catch (err) {
    await updateIntegrationLog(integrationId, eventType, "failed", null, err.message);
    throw err;
  }
}

async function processHubspotJob({ integrationId, config, eventType, payload }) {
  try {
    const result = await logHubspotActivity(config, eventType, payload);
    await updateIntegrationLog(integrationId, eventType, "success", result);
    return { sent: true, noteId: result.noteId };
  } catch (err) {
    await updateIntegrationLog(integrationId, eventType, "failed", null, err.message);
    throw err;
  }
}

async function processMailchimpJob({ integrationId, config, eventType, payload }) {
  try {
    const result = await createDraftCampaign(config, eventType, payload);
    await updateIntegrationLog(integrationId, eventType, "success", result);
    return { sent: true, campaignId: result.campaignId };
  } catch (err) {
    await updateIntegrationLog(integrationId, eventType, "failed", null, err.message);
    throw err;
  }
}

async function processConvertkitJob({ integrationId, config, eventType, payload }) {
  try {
    const result = await createDraftBroadcast(config, eventType, payload);
    await updateIntegrationLog(integrationId, eventType, "success", result);
    return { sent: true, broadcastId: result.broadcastId };
  } catch (err) {
    await updateIntegrationLog(integrationId, eventType, "failed", null, err.message);
    throw err;
  }
}

async function processWordpressJob({ integrationId, config, eventType, payload }) {
  try {
    const result = await createDraftPost(config, eventType, payload);
    await updateIntegrationLog(integrationId, eventType, "success", result);
    return { sent: true, postId: result.postId };
  } catch (err) {
    await updateIntegrationLog(integrationId, eventType, "failed", null, err.message);
    throw err;
  }
}

async function processWebflowJob({ integrationId, config, eventType, payload }) {
  try {
    const result = await createDraftItem(config, eventType, payload);
    await updateIntegrationLog(integrationId, eventType, "success", result);
    return { sent: true, itemId: result.itemId };
  } catch (err) {
    await updateIntegrationLog(integrationId, eventType, "failed", null, err.message);
    throw err;
  }
}

async function updateIntegrationLog(integrationId, eventType, status, responseData, errorMessage) {
  try {
    await prisma.integrationLog.create({
      data: {
        integrationId,
        eventType,
        status,
        responseData: responseData ?? null,
        errorMessage: errorMessage ?? null,
      },
    });
  } catch {
    // Best-effort — don't crash if log write fails.
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
