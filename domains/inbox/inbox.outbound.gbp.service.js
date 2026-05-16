// SquadInbox outbound — workspace user → Google review public reply.
//
// Mirrors inbox.outbound.email.service.js shape: write a Message
// in SENDING state before the provider call, flip to SENT on
// success or FAILED on error so the audit trail survives every
// outcome. Idempotency key prevents duplicate public replies
// from a double-click or network retry.
//
// Capability contract:
//   - Conversation must exist + belong to clientId.
//   - Conversation.provider must be GOOGLE_BUSINESS.
//   - The inbound Message we're replying to must have a non-null
//     externalMessageId (the Google review.name).
//   - The workspace's GOOGLE_BUSINESS_PROFILE connection must:
//       - exist + status === CONNECTED
//       - have externalAccountId containing "/locations/"
//       - have business.manage in scopes
//       - have a refreshable access token
//
// On capability failure → 412 PROVIDER_NOT_AVAILABLE with a
// recognizable reason string the UI surfaces verbatim.

import { prisma } from "../../prisma.js";
import { decryptToken, encryptToken } from "../../lib/tokenCrypto.js";
import {
  GBP_SCOPES,
  updateReply,
  refreshAccessToken,
} from "../studio/oauth/googleBusinessProfile.oauth.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Send a public reply to a Google review.
 *
 * @param {string} clientId
 * @param {string} conversationId
 * @param {string} userId — Auth0 sub of the workspace user
 * @param {{ body: string, idempotencyKey?: string }} opts
 * @returns {Promise<Message>} the updated Message row
 *
 * Errors thrown (each carries .status + .code):
 *   400 BODY_REQUIRED
 *   404 CONVERSATION_NOT_FOUND
 *   404 NO_INBOUND_REVIEW         — conversation has no Google review message
 *   412 PROVIDER_NOT_AVAILABLE    — workspace lacks a connected GBP location
 *                                    with business.manage scope
 *   409 SEND_IN_PROGRESS          — repeated key, prior attempt still SENDING
 *   502 PROVIDER_FAILED           — Google rejected the reply
 *   503 PROVIDER_UNREACHABLE      — token refresh failed / network error
 */
export async function sendGbpReviewReply(
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

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, clientId },
    include: {
      messages: {
        where: { party: "CONTACT" },
        orderBy: { createdAt: "asc" },
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
  if (conversation.provider !== "GOOGLE_BUSINESS") {
    const err = new Error("Conversation is not a Google review");
    err.status = 412;
    err.code = "WRONG_PROVIDER";
    throw err;
  }
  const reviewMsg = conversation.messages[0];
  if (!reviewMsg?.externalMessageId) {
    const err = new Error("No inbound review to reply to");
    err.status = 404;
    err.code = "NO_INBOUND_REVIEW";
    throw err;
  }

  // Capability check — pulls the GBP connection scoped to this
  // workspace + verifies it's fully set up. Refuses to attempt a
  // send if anything's missing.
  const conn = await prisma.channelConnection.findUnique({
    where: {
      clientId_channel: { clientId, channel: "GOOGLE_BUSINESS_PROFILE" },
    },
  });
  if (!conn || conn.status !== "CONNECTED") {
    const err = new Error("Connect a Google Business Profile location to reply to reviews.");
    err.status = 412;
    err.code = "PROVIDER_NOT_AVAILABLE";
    throw err;
  }
  if (!conn.externalAccountId?.includes("/locations/")) {
    const err = new Error(
      "Pick a Google Business Profile location before sending review replies.",
    );
    err.status = 412;
    err.code = "PROVIDER_NOT_AVAILABLE";
    throw err;
  }
  if (!Array.isArray(conn.scopes) || !conn.scopes.includes(GBP_SCOPES[0])) {
    const err = new Error(
      "Google Business Profile is connected, but review reply permission is not available.",
    );
    err.status = 412;
    err.code = "PROVIDER_NOT_AVAILABLE";
    throw err;
  }

  // Idempotency pre-check — same pattern as email send.
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
        channel: "SOCIAL_DM", // closest existing enum value; review channel can come later
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
      // Race: a concurrent request created the Message between our
      // pre-check and create. Return that winner.
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

  // Step 2: refresh token if needed, then call updateReply.
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
    const err = new Error("Google Business Profile is unreachable. Try again in a minute.");
    err.status = 503;
    err.code = "PROVIDER_UNREACHABLE";
    err.providerError = refreshErr?.message ?? String(refreshErr);
    throw err;
  }

  try {
    await updateReply({
      accessToken,
      reviewName: reviewMsg.externalMessageId,
      comment: body.trim(),
    });
  } catch (callErr) {
    const httpStatus = callErr?.status ?? 502;
    const reason = callErr?.message ?? "GBP updateReply failed";
    console.error("[INBOX_OUTBOUND_GBP] updateReply threw:", {
      messageId: messageRow.id,
      conversationId,
      clientId,
      reviewName: reviewMsg.externalMessageId,
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

  // Step 3: mark SENT. providerMessageId mirrors the reviewName
  // (Google's reply is keyed to the review itself — one reply
  // per review, mutable via the same PUT endpoint).
  const sent = await prisma.message.update({
    where: { id: messageRow.id },
    data: {
      deliveryStatus: "SENT",
      providerMessageId: reviewMsg.externalMessageId,
      externalMessageId: `${reviewMsg.externalMessageId}/reply`,
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
