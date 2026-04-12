// Webflow provider — creates draft CMS items via the Webflow API (v2).
// Never auto-publishes — items are created in draft (staged) state only.
//
// Config shape (stored in Integration.config):
//   { apiToken: string, collectionId: string }
//
// The CMS collection should have at minimum a "Name" field (auto-mapped)
// and a "Post Body" rich text field (slug: "post-body").

const WEBFLOW_API = "https://api.webflow.com/v2";

/**
 * Build CMS item fields from an event.
 */
function buildItemFields(eventType, payload = {}) {
  const { platformName, clientName, body, count } = payload;

  if (eventType === "POST_PUBLISHED") {
    const name = platformName && clientName
      ? `New post published to ${platformName} for ${clientName}`
      : "New post published";
    const postBody = body || "A new post has been published via Squadpitch.";
    return { name, postBody };
  }

  if (eventType === "BATCH_COMPLETE") {
    const name = count
      ? `Batch complete — ${count} posts ready`
      : "Batch complete";
    const postBody = "Your batch content generation is complete and ready for review.";
    return { name, postBody };
  }

  // Fallback
  const name = `Squadpitch: ${eventType.replace(/_/g, " ").toLowerCase()}`;
  const postBody = `Event: ${eventType}`;
  return { name, postBody };
}

/**
 * Create a draft CMS item in Webflow.
 *
 * @param {{ apiToken: string, collectionId: string }} config
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: boolean, itemId?: string }}
 */
export async function createDraftItem(config, eventType, payload) {
  const { apiToken, collectionId } = config;
  const { name, postBody } = buildItemFields(eventType, payload);

  const res = await fetch(`${WEBFLOW_API}/collections/${collectionId}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      isArchived: false,
      isDraft: true,
      fieldData: {
        name,
        slug: `squadpitch-${Date.now()}`,
        "post-body": postBody,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`Webflow API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text);
  return { success: true, itemId: data.id };
}

/**
 * Validate a Webflow config by fetching the collection.
 *
 * @param {{ apiToken: string, collectionId: string }} config
 * @returns {{ valid: boolean }}
 */
export async function validateConfig(config) {
  const { apiToken, collectionId } = config;

  const res = await fetch(`${WEBFLOW_API}/collections/${collectionId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webflow validation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return { valid: true };
}
