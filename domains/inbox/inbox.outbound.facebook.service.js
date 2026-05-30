// SquadInbox outbound — workspace user → Facebook Page public comment reply.
//
// Mirrors inbox.outbound.youtube.service.js / inbox.outbound.threads.service.js:
// write a Message in SENDING state before the provider call, flip to
// SENT on success or FAILED on error so the audit trail survives
// every outcome. Idempotency key prevents duplicate public replies
// from a double-click or network retry.
//
// Capability contract:
//   - Conversation must exist + belong to clientId.
//   - Conversation.provider must be FACEBOOK.
//   - The inbound comment we're replying to must have a non-null
//     externalMessageId (the FB comment id).
//   - Workspace's FACEBOOK connection must:
//       - exist + status === CONNECTED
//       - have externalAccountId (the Page id)
//       - have pages_manage_engagement in scopes
//
// Endpoint: `POST graph.facebook.com/v19.0/{comment-id}/comments`
// authenticated with the Page access token (which is what the
// FACEBOOK ChannelConnection stores after Facebook Login OAuth).
// Returns `{ id: "<new_comment_id>" }`.
//
// On capability failure → 412 PROVIDER_NOT_AVAILABLE with a
// recognizable reason string the UI surfaces verbatim.

import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { META_GRAPH_BASE } from "../studio/meta.constants.js";

const REQUIRED_SCOPE = "pages_manage_engagement";

class FacebookReplyError extends Error {
  constructor(message, { status, code, providerError } = {}) {
    super(message);
    this.name = "FacebookReplyError";
    this.status = status ?? 502;
    this.code = code ?? "FACEBOOK_REPLY_FAILED";
    this.providerError = providerError ?? null;
  }
}

async function facebookPost(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new FacebookReplyError(
      body?.error?.message ?? `Facebook call failed with ${res.status}`,
      { status: res.status, providerError: body?.error ?? body },
    );
  }
  return body;
}

/**
 * Send a public reply to a Facebook Page comment.
 *
 * Throws (status + code):
 *   400 BODY_REQUIRED
 *   404 CONVERSATION_NOT_FOUND
 *   412 WRONG_PROVIDER
 *   404 NO_INBOUND_COMMENT
 *   412 PROVIDER_NOT_AVAILABLE
 *   409 SEND_IN_PROGRESS
 *   502 PROVIDER_FAILED
 *   503 PROVIDER_UNREACHABLE
 */
export async function sendFacebookCommentReply(
  clientId,
  conversationId,
  userId,
  { body, idempotencyKey } = {},
) {
  if (!body || typeof body !== "string" || body.trim().length === 0) {
    throw new FacebookReplyError("Body is required", {
      status: 400,
      code: "BODY_REQUIRED",
    });
  }
  const trimmed = body.trim();

  // Pick the LATEST inbound CONTACT message — comment threads
  // stack, "Reply" intends the thing the user is currently reading.
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
    throw new FacebookReplyError("Conversation not found", {
      status: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
  }
  if (conversation.provider !== "FACEBOOK") {
    throw new FacebookReplyError("Conversation is not a Facebook comment", {
      status: 412,
      code: "WRONG_PROVIDER",
    });
  }
  const inbound = conversation.messages[0];
  if (!inbound?.externalMessageId) {
    throw new FacebookReplyError("No inbound Facebook comment to reply to", {
      status: 404,
      code: "NO_INBOUND_COMMENT",
    });
  }

  // Capability check — verify the FACEBOOK connection is fully
  // set up + carries pages_manage_engagement in its granted scopes.
  const conn = await prisma.channelConnection.findUnique({
    where: { clientId_channel: { clientId, channel: "FACEBOOK" } },
  });
  if (!conn || conn.status !== "CONNECTED") {
    throw new FacebookReplyError("Connect Facebook to reply to comments.", {
      status: 412,
      code: "PROVIDER_NOT_AVAILABLE",
    });
  }
  if (!conn.externalAccountId) {
    throw new FacebookReplyError(
      "Facebook is connected but missing a Page id — reconnect to refresh.",
      { status: 412, code: "PROVIDER_NOT_AVAILABLE" },
    );
  }
  if (!Array.isArray(conn.scopes) || !conn.scopes.includes(REQUIRED_SCOPE)) {
    throw new FacebookReplyError(
      "Reconnect Facebook and grant the comment-reply permission (pages_manage_engagement).",
      { status: 412, code: "PROVIDER_NOT_AVAILABLE" },
    );
  }

  // Idempotency pre-check.
  if (idempotencyKey) {
    const existing = await prisma.message.findFirst({
      where: { conversationId, idempotencyKey },
    });
    if (existing) {
      if (existing.deliveryStatus === "SENDING") {
        throw new FacebookReplyError(
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
          throw new FacebookReplyError(
            "A reply with this idempotency key is already in progress",
            { status: 409, code: "SEND_IN_PROGRESS" },
          );
        }
        return racedWinner;
      }
    }
    throw createErr;
  }

  // Step 2: post the reply to the FB comment. Page access tokens
  // are long-lived (~60d) and don't carry a separate refresh
  // token — the meta.refresh adapter rolls them at near-expiry.
  // We use the current decrypted token here; if it's expired the
  // call returns OAuthException (code 190) which we map to
  // PROVIDER_FAILED so the FE shows the reconnect prompt.
  const accessToken = decryptToken(conn.accessToken);
  let publishedId;
  try {
    const published = await facebookPost(
      `${META_GRAPH_BASE}/${encodeURIComponent(inbound.externalMessageId)}/comments`,
      {
        message: trimmed,
        access_token: accessToken,
      },
    );
    if (!published?.id) {
      throw new FacebookReplyError("Facebook reply response missing id", {
        providerError: published,
      });
    }
    publishedId = String(published.id);
  } catch (callErr) {
    const httpStatus = callErr?.status ?? 502;
    const reason = callErr?.message ?? "Facebook reply failed";
    console.error("[INBOX_OUTBOUND_FB] reply failed:", {
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
    throw new FacebookReplyError(reason, {
      status: httpStatus >= 400 && httpStatus < 500 ? 502 : 503,
      code:
        httpStatus >= 400 && httpStatus < 500
          ? "PROVIDER_FAILED"
          : "PROVIDER_UNREACHABLE",
      providerError: reason,
    });
  }

  // Step 3: mark SENT. externalMessageId = FB's returned reply id
  // so the webhook echo guard in inbox.meta.ingestion.service.js's
  // ECHO_FROM_PAGE branch (and our own dedupe) won't ingest our
  // own outbound when FB re-emits the change.
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
