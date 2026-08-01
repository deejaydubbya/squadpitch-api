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

import { pinterestApiUrl } from "../../oauth/pinterestApi.js";

const PIN_TITLE_MAX = 100;
const PIN_DESCRIPTION_MAX = 500;
const PIN_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

// Pinterest's documented error code for "Trial app cannot create Pins
// in production — use sandbox instead". HTTP 403 + this code means the
// connection is fine; the operator just needs to flip
// PINTEREST_USE_SANDBOX=true (or graduate the app to Standard access).
const TRIAL_PRODUCTION_BLOCKED_CODE = 29;

class PinterestPublishError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "PinterestPublishError";
    this.status = status ?? 502;
    this.code = code ?? "PINTEREST_PUBLISH_FAILED";
  }
}

function safeDestinationLink(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" || host === "127.0.0.1" || host === "::1" ||
      host.endsWith(".local") || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function classifyPinterestBadRequest(body) {
  const message = String(body?.message ?? body?.error_description ?? "").toLowerCase();
  const providerCode = Number.isFinite(Number(body?.code)) ? Number(body.code) : null;
  if (message.includes("board")) {
    return { code: "PINTEREST_INVALID_BOARD", message: "Pinterest rejected the selected board. Refresh the board list and select it again.", providerCode };
  }
  if (message.includes("image") || message.includes("media") || message.includes("source")) {
    return { code: "PINTEREST_INVALID_IMAGE", message: "Pinterest could not accept this image. Choose a public JPEG or PNG and try again.", providerCode };
  }
  if (message.includes("link") || message.includes("url")) {
    return { code: "PINTEREST_INVALID_LINK", message: "Pinterest rejected the destination or image URL.", providerCode };
  }
  if (message.includes("title")) {
    return { code: "PINTEREST_INVALID_TITLE", message: "Pinterest rejected the Pin title.", providerCode };
  }
  if (message.includes("description")) {
    return { code: "PINTEREST_INVALID_DESCRIPTION", message: "Pinterest rejected the Pin description.", providerCode };
  }
  return { code: "PINTEREST_INVALID_REQUEST", message: "Pinterest rejected the Pin payload. Try a different image; if it continues, contact support with the request time.", providerCode };
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

async function cloudinaryBase64MediaSource(mediaUrl) {
  let url;
  try {
    url = new URL(mediaUrl);
  } catch {
    return null;
  }
  // Draft media is normally hosted here. Restrict the server-side fallback
  // to that trusted host so a user-controlled URL cannot turn publishing
  // into an internal-network fetch.
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com") return null;

  const response = await fetch(url.toString(), {
    headers: { Accept: "image/jpeg,image/png" },
  });
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
  if (!new Set(["image/jpeg", "image/png"]).has(contentType)) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > PIN_IMAGE_MAX_BYTES) return null;
  return {
    source_type: "image_base64",
    content_type: contentType,
    data: bytes.toString("base64"),
    is_standard: true,
  };
}

async function sendPin(token, body) {
  const response = await fetch(pinterestApiUrl("/v5/pins"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, responseBody: await response.json().catch(() => ({})) };
}

export const pinterestAdapter = {
  channel: "PINTEREST",

  async validatePublishTarget({ draft, connection }) {
    // Pinterest board ids are numeric strings (`^\d+$`). Right after
    // OAuth the connection's externalAccountId is the *username* — the
    // user still needs to pick a board via the picker UI before we can
    // publish. Reject early with a friendly message instead of letting
    // Pinterest's API return its raw regex-mismatch error.
    const accountId = connection?.externalAccountId;
    if (!accountId || !/^\d+$/.test(String(accountId))) {
      throw new PinterestPublishError(
        "Pinterest needs a board picked before publishing. Open Settings → Channels and choose a board.",
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
        // Required by Pinterest's current image_url media-source schema.
        // Standard organic Pins must explicitly opt into this variant.
        is_standard: true,
      },
    };

    // If the workspace has a website / brand URL we can attach it as
    // the Pin's outbound link — Pinterest treats this as the primary
    // click destination. Skipping when absent is fine; Pins without
    // links still publish.
    const link = safeDestinationLink(client?.websiteUrl);
    if (link) body.link = link;

    let { response: res, responseBody: respBody } = await sendPin(token, body);

    // Pinterest occasionally returns a generic validation 400 after its
    // crawler fails to ingest an otherwise-public image URL. For media that
    // Squadpitch itself hosts on Cloudinary, retry the failed request once
    // using Pinterest's documented base64 source. A 400 cannot have created
    // a Pin, so this cannot duplicate a successful publication.
    if (res.status === 400 && body.media_source.source_type === "image_url") {
      const fallbackSource = await cloudinaryBase64MediaSource(draft.mediaUrl);
      if (fallbackSource) {
        ({ response: res, responseBody: respBody } = await sendPin(token, {
          ...body,
          media_source: fallbackSource,
        }));
      }
    }

    // Pinterest gates Trial-access apps from creating Pins on the
    // production host. Catch this specific case BEFORE the generic
    // 401/403 → AUTH_FAILED branch so the operator gets actionable
    // guidance instead of a misleading "needs to be reconnected".
    if (
      res.status === 403 &&
      Number(respBody?.code) === TRIAL_PRODUCTION_BLOCKED_CODE
    ) {
      throw new PinterestPublishError(
        "Your Pinterest app is in Trial access mode and can't publish to production. " +
          "Set PINTEREST_USE_SANDBOX=true to publish via Pinterest's sandbox API, " +
          "or submit your Pinterest app for Standard access review.",
        {
          status: 403,
          code: "PINTEREST_TRIAL_PRODUCTION_BLOCKED",
        }
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new PinterestPublishError(
        "Pinterest needs to be reconnected.",
        { status: res.status, code: "AUTH_FAILED" }
      );
    }
    if (res.status === 429) {
      throw Object.assign(
        new PinterestPublishError(
          "Pinterest is rate-limiting publish requests. Try again shortly.",
          { status: 429 }
        ),
        { transient: true }
      );
    }
    if (!res.ok) {
      if (res.status === 400) {
        const classified = classifyPinterestBadRequest(respBody);
        throw Object.assign(
          new PinterestPublishError(classified.message, {
            status: 400,
            code: classified.code,
          }),
          { providerCode: classified.providerCode },
        );
      }
      throw new PinterestPublishError(
        `Pinterest rejected this Pin (${res.status}).`,
        { status: res.status }
      );
    }

    const pinId = respBody?.id ?? null;
    if (!pinId) {
      throw new PinterestPublishError(
        "Pinterest did not return a Pin id.",
        { status: 502 }
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
