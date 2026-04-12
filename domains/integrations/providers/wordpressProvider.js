// WordPress provider — creates draft blog posts via the REST API.
// Never auto-publishes — posts are created with status "draft" only.
//
// Config shape (stored in Integration.config):
//   { siteUrl: string, username: string, applicationPassword: string }
//
// Uses WordPress Application Passwords for authentication.

/**
 * Build post content from an event.
 */
function buildPostContent(eventType, payload = {}) {
  const { platformName, clientName, body, count } = payload;

  if (eventType === "POST_PUBLISHED") {
    const title = platformName && clientName
      ? `New post published to ${platformName} for ${clientName}`
      : "New post published";
    const content = body || "A new post has been published via Squadpitch.";
    return { title, content };
  }

  if (eventType === "BATCH_COMPLETE") {
    const title = count
      ? `Batch complete — ${count} posts ready`
      : "Batch complete";
    const content = "Your batch content generation is complete and ready for review.";
    return { title, content };
  }

  // Fallback
  const title = `Squadpitch: ${eventType.replace(/_/g, " ").toLowerCase()}`;
  const content = `Event: ${eventType}`;
  return { title, content };
}

/**
 * Normalize site URL — strip trailing slash, ensure https.
 */
function normalizeSiteUrl(siteUrl) {
  let url = siteUrl.trim().replace(/\/+$/, "");
  if (!url.startsWith("http")) url = `https://${url}`;
  return url;
}

/**
 * Create a draft post in WordPress.
 *
 * @param {{ siteUrl: string, username: string, applicationPassword: string }} config
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: boolean, postId?: number }}
 */
export async function createDraftPost(config, eventType, payload) {
  const { siteUrl, username, applicationPassword } = config;
  const base = normalizeSiteUrl(siteUrl);
  const authHeader = `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString("base64")}`;
  const { title, content } = buildPostContent(eventType, payload);

  const res = await fetch(`${base}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      content,
      status: "draft",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`WordPress API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text);
  return { success: true, postId: data.id };
}

/**
 * Validate a WordPress config by fetching site info.
 *
 * @param {{ siteUrl: string, username: string, applicationPassword: string }} config
 * @returns {{ valid: boolean }}
 */
export async function validateConfig(config) {
  const { siteUrl, username, applicationPassword } = config;
  const base = normalizeSiteUrl(siteUrl);
  const authHeader = `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString("base64")}`;

  const res = await fetch(`${base}/wp-json/wp/v2/users/me`, {
    method: "GET",
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WordPress validation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return { valid: true };
}
