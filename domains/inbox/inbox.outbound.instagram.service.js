// SquadInbox outbound — workspace user → Instagram public comment reply.
//
// Post-IG-01 migration the INSTAGRAM ChannelConnection stores a
// direct Instagram long-lived USER token (instagram_business_*
// scopes), NOT a Facebook Page access token. Direct IG tokens are
// only valid against graph.instagram.com — graph.facebook.com
// rejects them with "Invalid OAuth access token - Cannot parse
// access token". Confirmed during publish path failure 2026-05-31,
// so all IG Business endpoints route through INSTAGRAM_GRAPH_BASE.
//
// Mirrors inbox.outbound.facebook.service.js shape: write a
// Message in SENDING state before the provider call, flip to
// SENT on success or FAILED on error, idempotency-keyed.
//
// Capability contract:
//   - Conversation must exist + belong to clientId.
//   - Conversation.provider must be INSTAGRAM.
//   - The inbound comment we're replying to must have a non-null
//     externalMessageId (the IG comment id).
//   - Workspace's INSTAGRAM connection must:
//       - exist + status === CONNECTED
//       - have externalAccountId (the IG user id from /me)
//       - have instagram_business_manage_comments in scopes
//       - have a long-lived token (refreshable via instagramRefresh)
//
// Endpoint: `POST graph.instagram.com/{ig-comment-id}/replies`
// authenticated with the long-lived IG user token. Returns
// `{ id: "<new_comment_id>" }`.
//
// Private DM scopes are explicitly NOT used here — this is a
// public-comment-only adapter, in line with the App Review posture.

import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { INSTAGRAM_GRAPH_BASE } from "../studio/meta.constants.js";
import { ensureValidAccessToken } from "../studio/tokenRefreshService.js";

const REQUIRED_SCOPE = "instagram_business_manage_comments";

class InstagramReplyError extends Error {
  constructor(message, { status, code, providerError } = {}) {
    super(message);
    this.name = "InstagramReplyError";
    this.status = status ?? 502;
    this.code = code ?? "INSTAGRAM_REPLY_FAILED";
    this.providerError = providerError ?? null;
  }
}

async function instagramPost(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new InstagramReplyError(
      body?.error?.message ?? `Instagram call failed with ${res.status}`,
      { status: res.status, providerError: body?.error ?? body },
    );
  }
  return body;
}

/**
 * Send a public reply to an Instagram comment.
 *
 * Throws (status + code):
 *   400 BODY_REQUIRED
 *   404 CONVERSATION_NOT_FOUND
 *   412 WRONG_PROVIDER
 *   404 NO_INBOUND_COMMENT
 *   412 PROVIDER_NOT_AVAILABLE
 *   409 SEND_IN_PROGRESS
 *   502 PROVIDER_FAILED       — IG rejected the reply (perm/auth/etc.)
 *   503 PROVIDER_UNREACHABLE  — token refresh failed / network error
 */
export async function sendInstagramCommentReply(
  clientId,
  conversationId,
  userId,
  { body, idempotencyKey } = {},
) {
  if (!body || typeof body !== "string" || body.trim().length === 0) {
    throw new InstagramReplyError("Body is required", {
      status: 400,
      code: "BODY_REQUIRED",
    });
  }
  const trimmed = body.trim();

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, clientId },
    include: {
      messages: {
        where: { party: "CONTACT" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!conversation) {
    throw new InstagramReplyError("Conversation not found", {
      status: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
  }
  if (conversation.provider !== "INSTAGRAM") {
    throw new InstagramReplyError("Conversation is not an Instagram comment", {
      status: 412,
      code: "WRONG_PROVIDER",
    });
  }
  const inbound = conversation.messages[0];
  if (!inbound?.externalMessageId) {
    throw new InstagramReplyError("No inbound Instagram comment to reply to", {
      status: 404,
      code: "NO_INBOUND_COMMENT",
    });
  }

  const conn = await prisma.channelConnection.findUnique({
    where: { clientId_channel: { clientId, channel: "INSTAGRAM" } },
  });
  if (!conn || conn.status !== "CONNECTED") {
    throw new InstagramReplyError("Connect Instagram to reply to comments.", {
      status: 412,
      code: "PROVIDER_NOT_AVAILABLE",
    });
  }
  if (!conn.externalAccountId) {
    throw new InstagramReplyError(
      "Instagram is connected but missing a user id — reconnect to refresh.",
      { status: 412, code: "PROVIDER_NOT_AVAILABLE" },
    );
  }
  if (!Array.isArray(conn.scopes) || !conn.scopes.includes(REQUIRED_SCOPE)) {
    throw new InstagramReplyError(
      "Reconnect Instagram and grant the comment-reply permission (instagram_business_manage_comments).",
      { status: 412, code: "PROVIDER_NOT_AVAILABLE" },
    );
  }

  // Idempotency pre-check — same pattern as the other outbound services.
  if (idempotencyKey) {
    const existing = await prisma.message.findFirst({
      where: { conversationId, idempotencyKey },
    });
    if (existing) {
      if (existing.deliveryStatus === "SENDING") {
        throw new InstagramReplyError(
          "A reply with this idempotency key is already in progress",
          { status: 409, code: "SEND_IN_PROGRESS" },
        );
      }
      return existing;
    }
  }

  // Step 1: write Message in SENDING state BEFORE the provider call.
  let messageRow;
  try {
    messageRow = await prisma.message.create({
      data: {
        conversationId,
        party: "WORKSPACE",
        channel: "SOCIAL_DM",
        body: trimmed,
        authorUserId: userId,
        idempotencyKey: idempotencyKey ?? null,
        visibility: "PUBLIC",
        deliveryStatus: "SENDING",
        lastAttemptedAt: new Date(),
      },
    });
  } catch (createErr) {
    if (idempotencyKey && createErr?.code === "P2002") {
      const racedWinner = await prisma.message.findFirst({
        where: { conversationId, idempotencyKey },
      });
      if (racedWinner) {
        if (racedWinner.deliveryStatus === "SENDING") {
          throw new InstagramReplyError(
            "A reply with this idempotency key is already in progress",
            { status: 409, code: "SEND_IN_PROGRESS" },
          );
        }
        return racedWinner;
      }
    }
    throw createErr;
  }

  // Step 2: refresh token if needed.
  // Routes through the IG-specific refresh adapter (instagramRefresh)
  // which hits graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token.
  let accessToken;
  try {
    const fresh = await ensureValidAccessToken(conn);
    // ensureValidAccessToken returns the connection row unchanged
    // when the token is fresh, so the accessToken is still
    // ciphertext — always decrypt before handing to Graph.
    accessToken = decryptToken(fresh?.accessToken ?? conn.accessToken);
  } catch (refreshErr) {
    await prisma.message.update({
      where: { id: messageRow.id },
      data: {
        deliveryStatus: "FAILED",
        errorReason: `token_refresh: ${refreshErr?.message ?? "unknown"}`,
      },
    });
    throw new InstagramReplyError(
      "Instagram is unreachable. Try again in a minute.",
      {
        status: 503,
        code: "PROVIDER_UNREACHABLE",
        providerError: refreshErr?.message ?? String(refreshErr),
      },
    );
  }

  // Step 3: post the reply to the IG comment.
  let publishedId;
  try {
    const published = await instagramPost(
      `${INSTAGRAM_GRAPH_BASE}/${encodeURIComponent(inbound.externalMessageId)}/replies`,
      {
        message: trimmed,
        access_token: accessToken,
      },
    );
    if (!published?.id) {
      throw new InstagramReplyError("Instagram reply response missing id", {
        providerError: published,
      });
    }
    publishedId = String(published.id);
  } catch (callErr) {
    const httpStatus = callErr?.status ?? 502;
    const reason = callErr?.message ?? "Instagram reply failed";
    console.error("[INBOX_OUTBOUND_IG] reply failed:", {
      messageId: messageRow.id,
      conversationId,
      clientId,
      parentCommentId: inbound.externalMessageId,
      status: httpStatus,
      message: reason,
    });
    await prisma.message.update({
      where: { id: messageRow.id },
      data: {
        deliveryStatus: "FAILED",
        errorReason: `${httpStatus}: ${reason}`.slice(0, 4000),
      },
    });
    throw new InstagramReplyError(reason, {
      status: httpStatus >= 400 && httpStatus < 500 ? 502 : 503,
      code:
        httpStatus >= 400 && httpStatus < 500
          ? "PROVIDER_FAILED"
          : "PROVIDER_UNREACHABLE",
      providerError: reason,
    });
  }

  // Step 4: mark SENT. externalMessageId = the new IG reply id so
  // the webhook echo guard in inbox.meta.ingestion.service.js's
  // ECHO_FROM_ACCOUNT branch (and the explicit-id dedupe) won't
  // re-ingest our own outbound when IG re-emits the change.
  const sent = await prisma.message.update({
    where: { id: messageRow.id },
    data: {
      deliveryStatus: "SENT",
      providerMessageId: publishedId,
      externalMessageId: publishedId,
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: sent.createdAt,
      lastMessageFrom: "WORKSPACE",
      workspaceReadAt: sent.createdAt,
    },
  });

  return sent;
}
