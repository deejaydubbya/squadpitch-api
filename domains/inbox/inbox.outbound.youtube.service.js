// SquadInbox outbound — workspace user → YouTube public comment reply.
//
// Mirrors inbox.outbound.gbp.service.js shape: write a Message in
// SENDING state before the provider call, flip to SENT on success
// or FAILED on error so the audit trail survives every outcome.
// Idempotency key prevents duplicate public replies from a
// double-click or network retry.
//
// Capability contract:
//   - Conversation must exist + belong to clientId.
//   - Conversation.provider must be YOUTUBE.
//   - The inbound comment we're replying to must have a non-null
//     externalMessageId (the YouTube comment id).
//   - The workspace's YOUTUBE connection must:
//       - exist + status === CONNECTED
//       - have externalAccountId (the channel id)
//       - have youtube.force-ssl in scopes (gated by Google's
//         unverified-app guard for non-test-users; test users on
//         the Cloud project can grant it)
//       - have a refreshable access token
//
// On capability failure → 412 PROVIDER_NOT_AVAILABLE with a
// recognizable reason string the UI surfaces verbatim.

import { prisma } from "../../prisma.js";
import { decryptToken, encryptToken } from "../../lib/tokenCrypto.js";
import {
  YOUTUBE_FORCE_SSL_SCOPE,
  insertCommentReply,
  refreshAccessToken,
} from "../studio/oauth/youtube.oauth.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Send a public reply to a YouTube comment.
 *
 * @param {string} clientId
 * @param {string} conversationId
 * @param {string} userId — Auth0 sub of the workspace user
 * @param {{ body: string, idempotencyKey?: string }} opts
 * @returns {Promise<Message>} the persisted Message row
 *
 * Errors thrown (each carries .status + .code):
 *   400 BODY_REQUIRED
 *   404 CONVERSATION_NOT_FOUND
 *   412 WRONG_PROVIDER
 *   404 NO_INBOUND_COMMENT        — conversation has no YouTube comment to reply to
 *   412 PROVIDER_NOT_AVAILABLE    — workspace lacks a connected YouTube channel
 *                                    with youtube.force-ssl scope
 *   409 SEND_IN_PROGRESS          — repeated key, prior attempt still SENDING
 *   502 PROVIDER_FAILED           — YouTube rejected the reply
 *   503 PROVIDER_UNREACHABLE      — token refresh failed / network error
 */
export async function sendYouTubeCommentReply(
  clientId,
  conversationId,
  userId,
  { body, idempotencyKey } = {},
) {
  if (!body || typeof body !== "string" || body.trim().length === 0) {
    const err = new Error("Body is required");
    err.status = 400;
    err.code = "BODY_REQUIRED";
    throw err;
  }

  // Pick the LATEST inbound CONTACT message to reply to — comment
  // threads can stack (user comments, we reply, user comments
  // again on the same thread). The composer button intent is
  // "reply to the thing I'm reading," which is the latest.
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
    const err = new Error("Conversation not found");
    err.status = 404;
    err.code = "CONVERSATION_NOT_FOUND";
    throw err;
  }
  if (conversation.provider !== "YOUTUBE") {
    const err = new Error("Conversation is not a YouTube comment");
    err.status = 412;
    err.code = "WRONG_PROVIDER";
    throw err;
  }
  const inbound = conversation.messages[0];
  if (!inbound?.externalMessageId) {
    const err = new Error("No inbound YouTube comment to reply to");
    err.status = 404;
    err.code = "NO_INBOUND_COMMENT";
    throw err;
  }

  // Capability check — pulls the YouTube connection scoped to this
  // workspace + verifies it's fully set up.
  const conn = await prisma.channelConnection.findUnique({
    where: {
      clientId_channel: { clientId, channel: "YOUTUBE" },
    },
  });
  if (!conn || conn.status !== "CONNECTED") {
    const err = new Error("Connect YouTube to reply to comments.");
    err.status = 412;
    err.code = "PROVIDER_NOT_AVAILABLE";
    throw err;
  }
  if (!conn.externalAccountId) {
    const err = new Error(
      "YouTube is connected but missing a channel id — reconnect to refresh.",
    );
    err.status = 412;
    err.code = "PROVIDER_NOT_AVAILABLE";
    throw err;
  }
  if (!Array.isArray(conn.scopes) || !conn.scopes.includes(YOUTUBE_FORCE_SSL_SCOPE)) {
    const err = new Error(
      "Reconnect YouTube and grant the comment-reply permission (youtube.force-ssl).",
    );
    err.status = 412;
    err.code = "PROVIDER_NOT_AVAILABLE";
    throw err;
  }

  // Idempotency pre-check — same pattern as email + GBP send.
  if (idempotencyKey) {
    const existing = await prisma.message.findFirst({
      where: { conversationId, idempotencyKey },
    });
    if (existing) {
      if (existing.deliveryStatus === "SENDING") {
        const err = new Error("A reply with this idempotency key is already in progress");
        err.status = 409;
        err.code = "SEND_IN_PROGRESS";
        throw err;
      }
      return existing;
    }
  }

  // Step 1: write Message in SENDING state BEFORE the provider
  // call. An in-flight crash leaves an auditable row.
  let messageRow;
  try {
    messageRow = await prisma.message.create({
      data: {
        conversationId,
        party: "WORKSPACE",
        channel: "SOCIAL_DM",
        body: body.trim(),
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
          const err = new Error("A reply with this idempotency key is already in progress");
          err.status = 409;
          err.code = "SEND_IN_PROGRESS";
          throw err;
        }
        return racedWinner;
      }
    }
    throw createErr;
  }

  // Step 2: refresh token if needed, then call comments.insert.
  let accessToken;
  try {
    accessToken = await ensureFreshToken(conn);
  } catch (refreshErr) {
    await prisma.message.update({
      where: { id: messageRow.id },
      data: {
        deliveryStatus: "FAILED",
        errorReason: `token_refresh: ${refreshErr?.message ?? "unknown"}`,
      },
    });
    const err = new Error("YouTube is unreachable. Try again in a minute.");
    err.status = 503;
    err.code = "PROVIDER_UNREACHABLE";
    err.providerError = refreshErr?.message ?? String(refreshErr);
    throw err;
  }

  // YouTube comment-reply parentId rules:
  //   - If the inbound is a top-level comment (no parent), pass
  //     its id directly.
  //   - If the inbound is a reply (has parent), pass the TOP-LEVEL
  //     comment id as parent — YouTube replies are flat under the
  //     top-level comment, no nested threading.
  const parentId =
    typeof inbound.payloadJson?.parentId === "string" && inbound.payloadJson.parentId.length > 0
      ? inbound.payloadJson.parentId
      : inbound.externalMessageId;

  let inserted;
  try {
    inserted = await insertCommentReply({
      accessToken,
      parentId,
      text: body.trim(),
    });
  } catch (callErr) {
    const httpStatus = callErr?.status ?? 502;
    const reason = callErr?.message ?? "YouTube comments.insert failed";
    console.error("[INBOX_OUTBOUND_YT] insertCommentReply threw:", {
      messageId: messageRow.id,
      conversationId,
      clientId,
      parentId,
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
    const err = new Error(reason);
    err.status = httpStatus >= 400 && httpStatus < 500 ? 502 : 503;
    err.code = httpStatus >= 400 && httpStatus < 500 ? "PROVIDER_FAILED" : "PROVIDER_UNREACHABLE";
    err.providerError = reason;
    throw err;
  }

  // Step 3: mark SENT. providerMessageId + externalMessageId set
  // to YouTube's returned comment id so the next poll dedupes
  // against our own outbound (the OWN_AUTHOR short-circuit in
  // the ingestion service handles this too, but the explicit id
  // makes the audit trail clean).
  const sent = await prisma.message.update({
    where: { id: messageRow.id },
    data: {
      deliveryStatus: "SENT",
      providerMessageId: inserted?.commentId ?? null,
      externalMessageId: inserted?.commentId ?? null,
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

async function ensureFreshToken(connection) {
  let accessToken = decryptToken(connection.accessToken);
  const expiresAt = connection.tokenExpiresAt
    ? new Date(connection.tokenExpiresAt).getTime()
    : 0;
  if (expiresAt && expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return accessToken;
  }
  if (!connection.refreshToken) {
    const err = new Error("Refresh token missing");
    err.code = "AUTH_FAILED";
    throw err;
  }
  const plainRefresh = decryptToken(connection.refreshToken);
  const refreshed = await refreshAccessToken({ refreshToken: plainRefresh });
  const newAccess = refreshed.accessToken;
  await prisma.channelConnection
    .update({
      where: { id: connection.id },
      data: {
        accessToken: encryptToken(newAccess),
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        lastRefreshAt: new Date(),
        lastError: null,
      },
    })
    .catch(() => {});
  return newAccess;
}
