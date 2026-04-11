// X (Twitter) publishing adapter.
//
// Text tweet: POST https://api.x.com/2/tweets
// Text limit: 280 characters

const X_TEXT_MAX = 280;

class XPublishError extends Error {
  constructor(message, { status, code, xError } = {}) {
    super(message);
    this.name = "XPublishError";
    this.status = status ?? 502;
    this.code = code ?? "X_PUBLISH_FAILED";
    this.xError = xError ?? null;
  }
}

/**
 * Truncate text to `max` characters at the last sentence or word boundary.
 * Adds "..." when truncation occurs.
 */
function truncateAtBoundary(text, max) {
  if (text.length <= max) return text;
  const limit = max - 1; // room for "..."
  // Try to break at the last sentence-ending punctuation (.!?) before the limit.
  const sentenceMatch = text.slice(0, limit).match(/^([\s\S]*[.!?])\s/);
  if (sentenceMatch && sentenceMatch[1].length >= limit * 0.5) {
    return sentenceMatch[1];
  }
  // Fall back to the last word boundary.
  const wordBreak = text.lastIndexOf(" ", limit);
  if (wordBreak > limit * 0.5) {
    return text.slice(0, wordBreak) + "\u2026";
  }
  return text.slice(0, limit) + "\u2026";
}

function buildTweetText(draft) {
  const body = draft.body ?? "";
  const tags = Array.isArray(draft.hashtags) ? draft.hashtags : [];
  const bodyLower = body.toLowerCase();
  const newTags = tags
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => !bodyLower.includes(t.toLowerCase()));
  const tagLine = newTags.join(" ");

  // Best case: body + hashtags fit
  const withTags = tagLine ? `${body}\n\n${tagLine}` : body;
  if (withTags.length <= X_TEXT_MAX) return withTags;

  // Body alone fits — drop hashtags
  if (body.length <= X_TEXT_MAX) return body;

  // Body too long — truncate at a natural boundary
  return truncateAtBoundary(body, X_TEXT_MAX);
}

export const xAdapter = {
  channel: "X",

  async validatePublishTarget({ draft }) {
    const text = buildTweetText(draft);
    if (text.length > X_TEXT_MAX) {
      throw new XPublishError(
        `Tweet exceeds ${X_TEXT_MAX} characters (${text.length})`,
        { status: 400, code: "PUBLISH_FAILED_TEXT_TOO_LONG" }
      );
    }
    if (!text.trim()) {
      throw new XPublishError("Tweet text cannot be empty", {
        status: 400,
        code: "PUBLISH_FAILED_EMPTY",
      });
    }
    return { text };
  },

  async publishPost({ draft, connection }) {
    if (draft.mediaType === "video") {
      throw new XPublishError(
        "X video publishing is not yet supported",
        { status: 422, code: "X_VIDEO_NOT_SUPPORTED" }
      );
    }
    const { text } = await this.validatePublishTarget({ draft });
    const token = connection.accessToken;

    const res = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new XPublishError(
        body?.detail ?? body?.title ?? `X publish failed with ${res.status}`,
        { status: res.status, xError: body }
      );
    }

    const tweetId = body?.data?.id;
    if (!tweetId) {
      throw new XPublishError("X publish response missing tweet ID", {
        xError: body,
      });
    }

    // Build permalink — requires the username from the connection's displayName
    let externalPostUrl = null;
    const displayName = connection.displayName;
    if (displayName) {
      const username = displayName.startsWith("@")
        ? displayName.slice(1)
        : displayName;
      externalPostUrl = `https://x.com/${username}/status/${tweetId}`;
    }

    return { externalPostId: tweetId, externalPostUrl };
  },
};

export { XPublishError };
