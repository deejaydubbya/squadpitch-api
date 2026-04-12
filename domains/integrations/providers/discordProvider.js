// Discord notification provider via incoming webhooks.
// Sends rich embed messages to a configured Discord webhook URL.
//
// Config shape (stored in Integration.config):
//   { webhookUrl: string }

/**
 * Build a Discord embed for a notification event.
 */
function buildEmbed(eventType, payload = {}) {
  const { platformName, clientName, clientId, error, count } = payload;

  const configs = {
    POST_PUBLISHED: {
      title: "Post Published",
      description: platformName && clientName
        ? `Post published to **${platformName}** for **${clientName}**`
        : "A post was successfully published",
      color: 0x4ade80, // green
    },
    POST_FAILED: {
      title: "Post Failed",
      description: platformName && clientName
        ? `Post failed on **${platformName}** for **${clientName}**`
        : "A scheduled post failed to publish",
      color: 0xf87171, // red
    },
    BATCH_COMPLETE: {
      title: "Batch Complete",
      description: count
        ? `Batch complete — **${count} posts** ready for review`
        : "Batch content generation is complete",
      color: 0x60a5fa, // blue
    },
    CONNECTION_EXPIRED: {
      title: "Connection Expired",
      description: platformName && clientName
        ? `**${platformName}** connection expired for **${clientName}**`
        : "A channel connection has expired",
      color: 0xfbbf24, // yellow
    },
    USAGE_LIMIT_NEARING: {
      title: "Usage Limit Nearing",
      description: "You are approaching your usage limit",
      color: 0xfbbf24, // yellow
    },
    TEST: {
      title: "Test Notification",
      description: "This is a test notification from Squadpitch",
      color: 0x818cf8, // purple
    },
  };

  const config = configs[eventType];
  if (!config) return null;

  const embed = {
    title: config.title,
    description: config.description,
    color: config.color,
    timestamp: new Date().toISOString(),
    footer: { text: "Squadpitch" },
  };

  if (error) {
    embed.fields = [{ name: "Error", value: error, inline: false }];
  }

  return embed;
}

/**
 * Send a notification to Discord via incoming webhook.
 *
 * @param {{ webhookUrl: string }} config
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: boolean }}
 */
export async function sendDiscordNotification(config, eventType, payload) {
  const { webhookUrl } = config;
  const embed = buildEmbed(eventType, payload);
  if (!embed) return null;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed (${res.status}): ${body.slice(0, 300)}`);
  }

  return { success: true };
}
