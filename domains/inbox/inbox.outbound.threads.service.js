// SquadInbox outbound — workspace user → Threads public reply.
//
// Threads' reply primitive is "create a new thread with
// reply_to_id=<id>" through the same /me/threads → /me/threads_publish
// container pipeline that the publish adapter uses. We replicate
// the minimal text-only path inline here instead of importing the
// full publish adapter — the inbox reply has no campaign/media/
// validation concerns, and the publish adapter expects a Draft
// row we don't want to manufacture.
//
// Capability contract:
//   - env.THREADS_REPLY_ENABLED must be true (operational kill switch
//     — flips this whole code path off without a redeploy).
//   - Conversation must exist + belong to clientId, provider=THREADS.
//   - The inbound message we're replying to must have a non-null
//     externalMessageId.
//   - Connection: CONNECTED + externalAccountId (Threads user id)
//     + threads_manage_replies in scopes + a refreshable token.
//
// On capability failure → 412 PROVIDER_NOT_AVAILABLE with a
// recognizable reason string the UI surfaces verbatim.

import { prisma } from "../../prisma.js";
import { env } from "../../config/env.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { THREADS_GRAPH_BASE } from "../studio/threads.constants.js";
import { ensureValidAccessToken } from "../studio/tokenRefreshService.js";

const THREADS_TEXT_MAX = 500;
const REQUIRED_SCOPE = "threads_manage_replies";

class ThreadsReplyError extends Error {
  constructor(message, { status, code, providerError } = {}) {
    super(message);
    this.name = "ThreadsReplyError";
    this.status = status ?? 502;
    this.code = code ?? "THREADS_REPLY_FAILED";
    this.providerError = providerError ?? null;
  }
}

async function threadsPost(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ThreadsReplyError(
      body?.error?.message ?? `Threads call failed with ${res.status}`,
      { status: res.status, providerError: body?.error ?? body },
    );
  }
  return body;
}

/**
 * Send a public reply to a Threads reply (or root post).
 *
 * Throws (status + code):
 *   400 BODY_REQUIRED
 *   400 BODY_TOO_LONG
 *   404 CONVERSATION_NOT_FOUND
 *   412 WRONG_PROVIDER
 *   404 NO_INBOUND_REPLY
 *   412 PROVIDER_NOT_AVAILABLE
 *   409 SEND_IN_PROGRESS
 *   502 PROVIDER_FAILED
 *   503 PROVIDER_UNREACHABLE
 */
export async function sendThreadsReply(
  clientId,
  conversationId,
  userId,
  { body, idempotencyKey } = {},
) {
  if (!env.THREADS_REPLY_ENABLED) {
    const err = new ThreadsReplyError("Threads reply publishing is not enabled.", {
      status: 412,
      code: "PROVIDER_NOT_AVAILABLE",
    });
    throw err;
  }
  if (!body || typeof body !== "string" || body.trim().length === 0) {
    throw new ThreadsReplyError("Body is required", {
      status: 400,
      code: "BODY_REQUIRED",
    });
  }
  const trimmed = body.trim();
  if (trimmed.length > THREADS_TEXT_MAX) {
    throw new ThreadsReplyError(
      `Threads replies are capped at ${THREADS_TEXT_MAX} characters (${trimmed.length}).`,
      { status: 400, code: "BODY_TOO_LONG" },
    );
  }

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
    throw new ThreadsReplyError("Conversation not found", {
      status: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
  }
  if (conversation.provider !== "THREADS") {
    throw new ThreadsReplyError("Conversation is not a Threads reply", {
      status: 412,
      code: "WRONG_PROVIDER",
    });
  }
  const inbound = conversation.messages[0];
  if (!inbound?.externalMessageId) {
    throw new ThreadsReplyError("No inbound Threads reply to respond to", {
      status: 404,
      code: "NO_INBOUND_REPLY",
    });
  }

  const conn = await prisma.channelConnection.findUnique({
    where: { clientId_channel: { clientId, channel: "THREADS" } },
  });
  if (!conn || conn.status !== "CONNECTED") {
    throw new ThreadsReplyError("Connect Threads to reply to comments.", {
      status: 412,
      code: "PROVIDER_NOT_AVAILABLE",
    });
  }
  if (!conn.externalAccountId) {
    throw new ThreadsReplyError(
      "Threads is connected but missing a user id — reconnect to refresh.",
      { status: 412, code: "PROVIDER_NOT_AVAILABLE" },
    );
  }
  if (!Array.isArray(conn.scopes) || !conn.scopes.includes(REQUIRED_SCOPE)) {
    throw new ThreadsReplyError(
      "Reconnect Threads and grant the reply permission (threads_manage_replies).",
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
        throw new ThreadsReplyError(
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
          throw new ThreadsReplyError(
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
  let accessToken;
  try {
    // ensureValidAccessToken decrypts + refreshes near-expiry tokens.
    // We pass a synthetic shape since the helper accepts the connection
    // row's encrypted-token shape directly.
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
    throw new ThreadsReplyError("Threads is unreachable. Try again in a minute.", {
      status: 503,
      code: "PROVIDER_UNREACHABLE",
      providerError: refreshErr?.message ?? String(refreshErr),
    });
  }

  // Step 3: create reply container + publish.
  // reply_to_id is the immediate parent (the inbound reply id).
  // Threads handles the threading from there — we don't need to
  // pass the root post id.
  let publishedId;
  try {
    const container = await threadsPost(
      `${THREADS_GRAPH_BASE}/${encodeURIComponent(conn.externalAccountId)}/threads`,
      {
        media_type: "TEXT",
        text: trimmed,
        reply_to_id: inbound.externalMessageId,
        access_token: accessToken,
      },
    );
    if (!container?.id) {
      throw new ThreadsReplyError("Threads reply container missing id", {
        providerError: container,
      });
    }
    const published = await threadsPost(
      `${THREADS_GRAPH_BASE}/${encodeURIComponent(conn.externalAccountId)}/threads_publish`,
      {
        creation_id: container.id,
        access_token: accessToken,
      },
    );
    if (!published?.id) {
      throw new ThreadsReplyError("Threads reply publish response missing id", {
        providerError: published,
      });
    }
    publishedId = String(published.id);
  } catch (callErr) {
    const httpStatus = callErr?.status ?? 502;
    const reason = callErr?.message ?? "Threads reply failed";
    console.error("[INBOX_OUTBOUND_TH] reply failed:", {
      messageId: messageRow.id,
      conversationId,
      clientId,
      parentId: inbound.externalMessageId,
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
    throw new ThreadsReplyError(reason, {
      status: httpStatus >= 400 && httpStatus < 500 ? 502 : 503,
      code: httpStatus >= 400 && httpStatus < 500 ? "PROVIDER_FAILED" : "PROVIDER_UNREACHABLE",
      providerError: reason,
    });
  }

  // Step 4: mark SENT. externalMessageId = the new Threads post id
  // so the next ingestion poll dedupes against our own outbound
  // (the OWN_AUTHOR guard handles this too).
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
