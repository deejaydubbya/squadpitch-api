// Mailchimp provider — creates draft campaigns via the Marketing API.
// Never auto-sends — campaigns are created in "save" (draft) status only.
//
// Config shape (stored in Integration.config):
//   { apiKey: string, serverPrefix: string, listId: string }

/**
 * Build campaign content from an event.
 */
function buildCampaignContent(eventType, payload = {}) {
  const { platformName, clientName, body, count } = payload;

  if (eventType === "POST_PUBLISHED") {
    const subject = platformName && clientName
      ? `New post published to ${platformName} for ${clientName}`
      : "New post published";
    const html = body
      ? `<h2>${subject}</h2><div>${body}</div>`
      : `<h2>${subject}</h2><p>A new post has been published via Squadpitch.</p>`;
    return { subject, html };
  }

  if (eventType === "BATCH_COMPLETE") {
    const subject = count
      ? `Batch complete — ${count} posts ready`
      : "Batch complete";
    const html = `<h2>${subject}</h2><p>Your batch content generation is complete and ready for review.</p>`;
    return { subject, html };
  }

  // Fallback for other event types
  const subject = `Squadpitch: ${eventType.replace(/_/g, " ").toLowerCase()}`;
  const html = `<h2>${subject}</h2><p>Event: ${eventType}</p>`;
  return { subject, html };
}

/**
 * Create a draft campaign in Mailchimp.
 *
 * @param {{ apiKey: string, serverPrefix: string, listId: string }} config
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: boolean, campaignId?: string }}
 */
export async function createDraftCampaign(config, eventType, payload) {
  const { apiKey, serverPrefix, listId } = config;
  const baseUrl = `https://${serverPrefix}.api.mailchimp.com/3.0`;
  const authHeader = `Basic ${Buffer.from(`anystring:${apiKey}`).toString("base64")}`;
  const { subject, html } = buildCampaignContent(eventType, payload);

  // Step 1: Create the campaign in "save" (draft) status
  const createRes = await fetch(`${baseUrl}/campaigns`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "regular",
      recipients: { list_id: listId },
      settings: {
        subject_line: subject,
        title: `Squadpitch — ${subject}`,
        from_name: "Squadpitch",
        reply_to: "noreply@squadpitch.com",
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const createText = await createRes.text().catch(() => "");

  if (!createRes.ok) {
    throw new Error(`Mailchimp campaign create failed (${createRes.status}): ${createText.slice(0, 500)}`);
  }

  const campaign = JSON.parse(createText);
  const campaignId = campaign.id;

  // Step 2: Set campaign content
  const contentRes = await fetch(`${baseUrl}/campaigns/${campaignId}/content`, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ html }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!contentRes.ok) {
    const contentText = await contentRes.text().catch(() => "");
    throw new Error(`Mailchimp content set failed (${contentRes.status}): ${contentText.slice(0, 500)}`);
  }

  return { success: true, campaignId };
}

/**
 * Validate a Mailchimp config by pinging the API.
 *
 * @param {{ apiKey: string, serverPrefix: string, listId: string }} config
 * @returns {{ valid: boolean }}
 */
export async function validateConfig(config) {
  const { apiKey, serverPrefix } = config;
  const baseUrl = `https://${serverPrefix}.api.mailchimp.com/3.0`;
  const authHeader = `Basic ${Buffer.from(`anystring:${apiKey}`).toString("base64")}`;

  const res = await fetch(`${baseUrl}/ping`, {
    method: "GET",
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mailchimp validation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return { valid: true };
}
