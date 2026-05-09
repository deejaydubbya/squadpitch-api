// Pinterest publishing adapter — image Pins via API v5.
//
// Endpoint: POST https://api.pinterest.com/v5/pins
//
// Body shape:
//   {
//     "board_id": "...",                    // required
//     "title":    "...",                    // optional, max 100
//     "description": "...",                 // optional, max 500
//     "link":     "https://example.com/...", // optional
//     "media_source": {
//       "source_type": "image_url",
//       "url": "<publicly-accessible image URL>"
//     }
//   }
//
// First-version scope: image Pins only. Pinterest video Pins require
// a multi-part chunked upload that's much heavier than what the
// existing media pipeline currently exposes — implement once we've
// got that media work staged.

const PINS_URL = "https://api.pinterest.com/v5/pins";
const PIN_TITLE_MAX = 100;
const PIN_DESCRIPTION_MAX = 500;

class PinterestPublishError extends Error {
  constructor(message, { status, code, pinterestError } = {}) {
    super(message);
    this.name = "PinterestPublishError";
    this.status = status ?? 502;
    this.code = code ?? "PINTEREST_PUBLISH_FAILED";
    this.pinterestError = pinterestError ?? null;
  }
}

function deriveTitle(draft) {
  const body = draft.body ?? "";
  // Pinterest titles are short. Take the first line of the caption,
  // or fall back to the first sentence. Truncate to 100 chars per the
  // API limit (which is enforced server-side anyway).
  const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const candidate = firstLine.length > 0 ? firstLine : body.slice(0, PIN_TITLE_MAX);
  return candidate.length > PIN_TITLE_MAX
    ? candidate.slice(0, PIN_TITLE_MAX - 1) + "…"
    : candidate;
}

function deriveDescription(draft) {
  const body = draft.body ?? "";
  const tags = Array.isArray(draft.hashtags) ? draft.hashtags : [];
  const bodyLower = body.toLowerCase();
  const newTags = tags
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => !bodyLower.includes(t.toLowerCase()));
  const tagLine = newTags.join(" ");
  const combined = tagLine ? `${body}\n\n${tagLine}` : body;
  if (combined.length <= PIN_DESCRIPTION_MAX) return combined;
  // Trim to fit, preserving complete words where possible.
  return combined.slice(0, PIN_DESCRIPTION_MAX - 1).replace(/\s+\S*$/, "") + "…";
}

export const pinterestAdapter = {
  channel: "PINTEREST",

  async validatePublishTarget({ draft, connection }) {
    if (!connection?.externalAccountId) {
      throw new PinterestPublishError(
        "Pinterest connection has no board selected. Pick a board in Settings → Channels before publishing.",
        { status: 400, code: "BOARD_NOT_SELECTED" }
      );
    }
    if (!draft.mediaUrl) {
      throw new PinterestPublishError(
        "Pinterest posts require an image. Add media before publishing to Pinterest.",
        { status: 400, code: "PUBLISH_FAILED_NO_MEDIA" }
      );
    }
    if (draft.mediaType === "video") {
      // Defer video support — see header comment.
      throw new PinterestPublishError(
        "Pinterest video Pins are not supported yet. Use an image for now.",
        { status: 400, code: "VIDEO_NOT_SUPPORTED" }
      );
    }
    return { mediaUrl: draft.mediaUrl };
  },

  async publishPost({ draft, connection, client }) {
    await this.validatePublishTarget({ draft, connection });
    const token = connection.accessToken;
    const boardId = connection.externalAccountId;

    const body = {
      board_id: boardId,
      title: deriveTitle(draft),
      description: deriveDescription(draft),
      media_source: {
        source_type: "image_url",
        url: draft.mediaUrl,
      },
    };

    // If the workspace has a website / brand URL we can attach it as
    // the Pin's outbound link — Pinterest treats this as the primary
    // click destination. Skipping when absent is fine; Pins without
    // links still publish.
    const link = client?.websiteUrl ?? null;
    if (link) body.link = link;

    const res = await fetch(PINS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const respBody = await res.json().catch(() => ({}));

    if (res.status === 401 || res.status === 403) {
      throw new PinterestPublishError(
        "Pinterest needs to be reconnected.",
        { status: res.status, code: "AUTH_FAILED", pinterestError: respBody }
      );
    }
    if (res.status === 429) {
      throw Object.assign(
        new PinterestPublishError(
          "Pinterest is rate-limiting publish requests. Try again shortly.",
          { status: 429, pinterestError: respBody }
        ),
        { transient: true }
      );
    }
    if (!res.ok) {
      throw new PinterestPublishError(
        respBody?.message ?? `Pinterest rejected this Pin (${res.status}).`,
        { status: res.status, pinterestError: respBody }
      );
    }

    const pinId = respBody?.id ?? null;
    if (!pinId) {
      throw new PinterestPublishError(
        "Pinterest did not return a Pin id.",
        { status: 502, pinterestError: respBody }
      );
    }
    // /v5/pins doesn't return a public URL directly. The canonical
    // Pin URL pattern is https://www.pinterest.com/pin/<id>/, which
    // resolves once the Pin is live.
    const externalPostUrl = `https://www.pinterest.com/pin/${pinId}/`;

    return { externalPostId: String(pinId), externalPostUrl };
  },
};

export { PinterestPublishError };
