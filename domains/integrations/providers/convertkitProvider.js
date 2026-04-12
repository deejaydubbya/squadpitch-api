// ConvertKit provider — creates draft broadcasts via the v3 API.
// Never auto-sends — broadcasts are created in draft status only.
//
// Config shape (stored in Integration.config):
//   { apiSecret: string }

const CONVERTKIT_API = "https://api.convertkit.com/v3";

/**
 * Build broadcast content from an event.
 */
function buildBroadcastContent(eventType, payload = {}) {
  const { platformName, clientName, body, count } = payload;

  if (eventType === "POST_PUBLISHED") {
    const subject = platformName && clientName
      ? `New post published to ${platformName} for ${clientName}`
      : "New post published";
    const content = body || "A new post has been published via Squadpitch.";
    return { subject, content };
  }

  if (eventType === "BATCH_COMPLETE") {
    const subject = count
      ? `Batch complete — ${count} posts ready`
      : "Batch complete";
    const content = "Your batch content generation is complete and ready for review.";
    return { subject, content };
  }

  // Fallback for other event types
  const subject = `Squadpitch: ${eventType.replace(/_/g, " ").toLowerCase()}`;
  const content = `Event: ${eventType}`;
  return { subject, content };
}

/**
 * Create a draft broadcast in ConvertKit.
 *
 * @param {{ apiSecret: string }} config
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: boolean, broadcastId?: number }}
 */
export async function createDraftBroadcast(config, eventType, payload) {
  const { apiSecret } = config;
  const { subject, content } = buildBroadcastContent(eventType, payload);

  const res = await fetch(`${CONVERTKIT_API}/broadcasts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_secret: apiSecret,
      subject,
      content,
      draft: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`ConvertKit API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text);
  const broadcastId = data.broadcast?.id ?? data.id;
  return { success: true, broadcastId };
}

/**
 * Validate a ConvertKit config by checking the account endpoint.
 *
 * @param {{ apiSecret: string }} config
 * @returns {{ valid: boolean }}
 */
export async function validateConfig(config) {
  const { apiSecret } = config;

  const res = await fetch(`${CONVERTKIT_API}/account?api_secret=${apiSecret}`, {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ConvertKit validation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return { valid: true };
}
