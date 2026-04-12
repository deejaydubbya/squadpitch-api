// Notion integration provider.
// Creates pages in a Notion database via the Notion API.
//
// Config shape (stored in Integration.config):
//   { apiKey: string, databaseId: string }
//
// The database should have these properties (auto-created if missing):
//   Title (title), Event (rich_text), Platform (rich_text),
//   Client (rich_text), Date (date), Status (select)

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Build Notion page properties from an event.
 */
function buildProperties(eventType, payload = {}) {
  const { platformName, clientName, error, count, body } = payload;

  const titles = {
    POST_PUBLISHED: platformName
      ? `Published to ${platformName}`
      : "Post published",
    POST_FAILED: platformName
      ? `Failed on ${platformName}`
      : "Post failed",
    BATCH_COMPLETE: count
      ? `Batch complete — ${count} posts`
      : "Batch complete",
    CONNECTION_EXPIRED: platformName
      ? `${platformName} connection expired`
      : "Connection expired",
    USAGE_LIMIT_NEARING: "Usage limit nearing",
    TEST: "Test event",
  };

  const statusMap = {
    POST_PUBLISHED: "Success",
    POST_FAILED: "Failed",
    BATCH_COMPLETE: "Complete",
    CONNECTION_EXPIRED: "Warning",
    USAGE_LIMIT_NEARING: "Warning",
    TEST: "Test",
  };

  return {
    Title: {
      title: [{ text: { content: titles[eventType] || eventType } }],
    },
    Event: {
      rich_text: [{ text: { content: eventType } }],
    },
    Platform: {
      rich_text: [{ text: { content: platformName || "—" } }],
    },
    Client: {
      rich_text: [{ text: { content: clientName || "—" } }],
    },
    Date: {
      date: { start: new Date().toISOString() },
    },
    Status: {
      select: { name: statusMap[eventType] || "Unknown" },
    },
  };
}

/**
 * Create a page in a Notion database.
 *
 * @param {{ apiKey: string, databaseId: string }} config
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: boolean, pageId?: string, error?: string }}
 */
export async function createNotionPage(config, eventType, payload) {
  const { apiKey, databaseId } = config;

  const body = JSON.stringify({
    parent: { database_id: databaseId },
    properties: buildProperties(eventType, payload),
  });

  const res = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`Notion API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text);
  return { success: true, pageId: data.id };
}

/**
 * Validate a Notion config by querying the database.
 */
export async function validateNotionConfig(config) {
  const { apiKey, databaseId } = config;

  const res = await fetch(`${NOTION_API}/databases/${databaseId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Notion validation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return { valid: true };
}
