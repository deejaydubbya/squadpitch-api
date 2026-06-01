// Instagram webhook subscription.
//
// Wires the workspace's IG Business account to the Meta app's
// webhook product so Meta starts firing comment events for it.
//
//   POST graph.instagram.com/{ig-user-id}/subscribed_apps
//     ?subscribed_fields=comments
//     &access_token=<long-lived-IG-user-token>
//
// Per Meta's docs the IG Business Login flow has a TWO-LEVEL
// subscription model:
//   1. The Meta App's Dashboard subscribes the Instagram product
//      to specific webhook fields (callback URL + verify token +
//      `comments` field). Done once per app, manually in the UI.
//   2. Each IG Business / Creator account that wants to deliver
//      events for those fields has to subscribe ITSELF to the app
//      via this endpoint. Without it, Meta knows about the field
//      subscription but has no IG accounts to fire for.
//
// Idempotent on Meta's side — re-subscribing the same account
// returns `{ success: true }` without changing state, so callers
// don't need to gate on a "already subscribed" flag locally.
//
// Required scope: `instagram_business_manage_comments`. Without it
// Meta returns 200 OAuthException code=10 (no permission) — we
// surface that as MISSING_SCOPE so the UI can prompt for reconnect
// instead of erroring opaquely.

import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { INSTAGRAM_GRAPH_BASE } from "./meta.constants.js";

const REQUIRED_SCOPE = "instagram_business_manage_comments";
const SUBSCRIBED_FIELDS = "comments";

class InstagramSubscribeError extends Error {
  constructor(message, { status, code, providerError } = {}) {
    super(message);
    this.name = "InstagramSubscribeError";
    this.status = status ?? 502;
    this.code = code ?? "INSTAGRAM_SUBSCRIBE_FAILED";
    this.providerError = providerError ?? null;
  }
}

/**
 * Subscribe an IG Business account to the Meta App's webhook
 * subscription for the `comments` field.
 *
 * @param {{ connectionId: string }} args
 * @returns {Promise<{ success: true, igUserId: string }>}
 */
export async function subscribeInstagramComments({ connectionId }) {
  const conn = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      channel: true,
      status: true,
      externalAccountId: true,
      accessToken: true,
      scopes: true,
    },
  });
  if (!conn) {
    throw new InstagramSubscribeError("Connection not found", {
      status: 404,
      code: "NOT_FOUND",
    });
  }
  if (conn.channel !== "INSTAGRAM") {
    throw new InstagramSubscribeError(
      "Connection is not an Instagram connection",
      { status: 400, code: "WRONG_CHANNEL" },
    );
  }
  if (conn.status !== "CONNECTED") {
    throw new InstagramSubscribeError(
      "Instagram connection is not active. Please reconnect.",
      { status: 400, code: "CONNECTION_NOT_ACTIVE" },
    );
  }
  if (!conn.externalAccountId) {
    throw new InstagramSubscribeError(
      "Connection is missing the Instagram user id",
      { status: 500, code: "MISSING_EXTERNAL_ACCOUNT_ID" },
    );
  }
  const scopes = Array.isArray(conn.scopes) ? conn.scopes : [];
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new InstagramSubscribeError(
      `Instagram connection is missing the ${REQUIRED_SCOPE} scope. Reconnect Instagram to grant it.`,
      { status: 400, code: "MISSING_SCOPE" },
    );
  }

  const token = decryptToken(conn.accessToken);
  const url =
    `${INSTAGRAM_GRAPH_BASE}/${encodeURIComponent(conn.externalAccountId)}/subscribed_apps` +
    `?subscribed_fields=${encodeURIComponent(SUBSCRIBED_FIELDS)}` +
    `&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url, { method: "POST" });
  const body = await res.json().catch(() => ({}));

  if (res.ok && body?.success === true) {
    return { success: true, igUserId: conn.externalAccountId };
  }

  // Meta error classification mirrors inbox.outbound.instagram.service.js.
  // Code 10 / 200 / 230 / 250 = OAuthException permission errors —
  // the token is valid but the granted scopes don't authorize this.
  // 190 = invalid/expired token. 5xx = transient.
  const code = body?.error?.code;
  if (res.status >= 500 || res.status === 429) {
    throw new InstagramSubscribeError(
      `Meta is temporarily unavailable (${res.status}). Try again shortly.`,
      { status: 503, code: "PROVIDER_UNREACHABLE", providerError: body?.error ?? body },
    );
  }
  if (code === 190 || res.status === 401) {
    throw new InstagramSubscribeError(
      "Instagram token has expired or been revoked. Please reconnect.",
      { status: 401, code: "TOKEN_INVALID", providerError: body?.error ?? body },
    );
  }
  if (code === 10 || code === 200 || code === 230 || code === 250) {
    throw new InstagramSubscribeError(
      "Instagram denied the subscription request — the granted scopes don't authorize webhooks for this account.",
      { status: 403, code: "PROVIDER_PERMISSION_DENIED", providerError: body?.error ?? body },
    );
  }
  throw new InstagramSubscribeError(
    body?.error?.message ?? `Instagram subscribed_apps call failed with ${res.status}`,
    { status: 502, code: "PROVIDER_FAILED", providerError: body?.error ?? body },
  );
}

export { InstagramSubscribeError };
