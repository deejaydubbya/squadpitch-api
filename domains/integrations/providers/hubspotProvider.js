// HubSpot CRM provider — logs activity as Notes via the Engagements API.
//
// Config shape (stored in Integration.config):
//   { accessToken: string }

const HUBSPOT_API = "https://api.hubapi.com";

/**
 * Build a note body from an event.
 */
function buildNoteBody(eventType, payload = {}) {
  const { platformName, clientName, error, count } = payload;

  const messages = {
    POST_PUBLISHED: platformName && clientName
      ? `Post published to ${platformName} for ${clientName}`
      : "A post was successfully published",
    POST_FAILED: platformName && clientName
      ? `Post failed on ${platformName} for ${clientName}${error ? ` — ${error}` : ""}`
      : `A scheduled post failed to publish${error ? ` — ${error}` : ""}`,
    BATCH_COMPLETE: count
      ? `Batch complete — ${count} posts ready for review`
      : "Batch content generation is complete",
    CONNECTION_EXPIRED: platformName && clientName
      ? `${platformName} connection expired for ${clientName}`
      : "A channel connection has expired",
    USAGE_LIMIT_NEARING: "Usage limit is approaching",
    TEST: "Test activity from Squadpitch",
  };

  return messages[eventType] || `Event: ${eventType}`;
}

/**
 * Log an activity as a Note in HubSpot.
 *
 * @param {{ accessToken: string }} config
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: boolean, noteId?: string }}
 */
export async function logActivity(config, eventType, payload) {
  const { accessToken } = config;
  const body = buildNoteBody(eventType, payload);
  const timestamp = Date.now();

  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/notes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        hs_timestamp: String(timestamp),
        hs_note_body: `[Squadpitch] ${body}`,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`HubSpot API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text);
  return { success: true, noteId: data.id };
}

/**
 * Validate a HubSpot config by checking account info.
 *
 * @param {{ accessToken: string }} config
 * @returns {{ valid: boolean }}
 */
export async function validateConfig(config) {
  const { accessToken } = config;

  const res = await fetch(`${HUBSPOT_API}/account-info/v3/details`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot validation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return { valid: true };
}
