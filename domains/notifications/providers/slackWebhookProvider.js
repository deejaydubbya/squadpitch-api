// Slack notification provider via incoming webhooks.
// Sends formatted Block Kit messages to a configured Slack webhook URL.

import { env } from "../../../config/env.js";

const APP = env.APP_URL;

/**
 * Build Slack Block Kit payload for a notification event.
 */
function buildSlackBlocks(eventType, payload = {}) {
  const { platformName, clientName, clientId, count, error, body } = payload;

  const configs = {
    TEST: {
      emoji: ":rocket:",
      text: payload.message || "Test notification from Squadpitch — your Slack integration is working!",
      color: "#8b5cf6",
    },
    POST_PUBLISHED: {
      emoji: ":white_check_mark:",
      text: platformName && clientName
        ? `Post published to *${platformName}* for *${clientName}*`
        : "A post was successfully published",
      color: "#4ade80",
    },
    POST_FAILED: {
      emoji: ":x:",
      text: platformName && clientName
        ? `Post failed to publish on *${platformName}* for *${clientName}*`
        : "A scheduled post failed to publish",
      detail: error ? `> *Reason:* ${error}` : null,
      color: "#f87171",
    },
    BATCH_COMPLETE: {
      emoji: ":package:",
      text: count
        ? `Batch complete — *${count} posts* ready for review`
        : "Batch content generation is complete",
      color: "#60a5fa",
    },
    CONNECTION_EXPIRED: {
      emoji: ":warning:",
      text: platformName && clientName
        ? `*${platformName}* connection expired for *${clientName}*`
        : "A channel connection has expired",
      color: "#fbbf24",
    },
  };

  const config = configs[eventType];
  if (!config) return null;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${config.emoji} *Squadpitch* — ${config.text}`,
      },
    },
  ];

  if (config.detail) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: config.detail },
    });
  }

  if (clientId) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open Dashboard" },
          url: `${APP}/clients/${clientId}`,
        },
      ],
    });
  }

  return { blocks, text: config.text };
}

/**
 * Send a notification to Slack via incoming webhook.
 * @param {string} webhookUrl
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: true } | null}
 */
export async function sendSlackNotification(webhookUrl, eventType, payload) {
  const message = buildSlackBlocks(eventType, payload);
  if (!message) return null;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack webhook failed (${res.status}): ${body}`);
  }

  return { success: true };
}
