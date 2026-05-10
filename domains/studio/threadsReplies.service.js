// Threads replies service.
//
// Demonstrates and uses the threads_read_replies + threads_manage_replies
// scopes. Two operations:
//   - listRepliesForDraft(draftId)         — read replies on a published thread
//   - setReplyHidden({ draftId, replyId, hide })
//                                          — hide / unhide a reply
//
// Both go through the existing connection.service token decryption,
// reuse the shared decode/refresh path, and surface AUTH_FAILED via
// the same code conventions other adapters use so the route layer
// renders consistent errors.
//
// Spec: https://developers.facebook.com/docs/threads/retrieve-and-manage-replies/

import { prisma } from "../../prisma.js";
import { logger } from "../../lib/logger.js";
import { getConnectionForAdapter } from "./connection.service.js";
import { ensureValidAccessToken } from "./tokenRefreshService.js";
import { THREADS_GRAPH_BASE } from "./threads.constants.js";

class ThreadsRepliesError extends Error {
  constructor(message, { status, code, providerError } = {}) {
    super(message);
    this.name = "ThreadsRepliesError";
    this.status = status ?? 502;
    this.code = code ?? "THREADS_REPLIES_FAILED";
    this.providerError = providerError ?? null;
  }
}

async function getThreadsConnection(clientId) {
  let connection = await getConnectionForAdapter(clientId, "THREADS");
  if (!connection) {
    throw new ThreadsRepliesError("No Threads connection on this workspace", {
      status: 400,
      code: "THREADS_NOT_CONNECTED",
    });
  }
  if (connection.status !== "CONNECTED") {
    throw new ThreadsRepliesError(
      `Threads connection status is ${connection.status}`,
      { status: 400, code: "THREADS_CONNECTION_NOT_READY" }
    );
  }
  // Refresh near-expiry tokens before any read/write.
  try {
    connection = await ensureValidAccessToken(connection);
  } catch (err) {
    throw new ThreadsRepliesError("Threads token refresh failed", {
      status: 401,
      code: "THREADS_TOKEN_REFRESH_FAILED",
      providerError: { message: err?.code ?? err?.message ?? null },
    });
  }
  return connection;
}

async function getDraftWithThreadId({ draftId, clientId }) {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: { id: true, clientId: true, channel: true, externalPostId: true },
  });
  if (!draft) {
    throw new ThreadsRepliesError("Draft not found", {
      status: 404,
      code: "DRAFT_NOT_FOUND",
    });
  }
  if (draft.clientId !== clientId) {
    throw new ThreadsRepliesError("Draft does not belong to this workspace", {
      status: 403,
      code: "DRAFT_NOT_IN_WORKSPACE",
    });
  }
  if (draft.channel !== "THREADS") {
    throw new ThreadsRepliesError("Draft is not a Threads post", {
      status: 400,
      code: "DRAFT_NOT_THREADS",
    });
  }
  if (!draft.externalPostId) {
    throw new ThreadsRepliesError("Draft has not been published yet", {
      status: 400,
      code: "DRAFT_NOT_PUBLISHED",
    });
  }
  return draft;
}

function classifyMetaError(res, body) {
  if (res.status === 401 || res.status === 403) {
    return new ThreadsRepliesError(
      body?.error?.message ?? "Threads auth failed",
      { status: res.status, code: "AUTH_FAILED", providerError: body?.error ?? null }
    );
  }
  if (res.status === 429 || res.status >= 500) {
    return new ThreadsRepliesError(
      body?.error?.message ?? `Threads API ${res.status}`,
      { status: res.status, code: "PROVIDER_TRANSIENT", providerError: body?.error ?? null }
    );
  }
  return new ThreadsRepliesError(
    body?.error?.message ?? `Threads API ${res.status}`,
    { status: res.status, providerError: body?.error ?? null }
  );
}

// List replies on a published Threads post.
//
// Threads exposes /{thread-id}/conversation which returns the full
// conversation tree. We pass `reverse=true` so newest replies are
// first and request a small field set — caller doesn't need bodies
// of every nested reply, just the top-level reply list for the UI.
export async function listRepliesForDraft({ draftId, clientId }) {
  const draft = await getDraftWithThreadId({ draftId, clientId });
  const connection = await getThreadsConnection(clientId);

  const fields = [
    "id",
    "text",
    "username",
    "timestamp",
    "permalink",
    "hide_status",
  ].join(",");
  const url =
    `${THREADS_GRAPH_BASE}/${encodeURIComponent(draft.externalPostId)}/conversation` +
    `?fields=${encodeURIComponent(fields)}` +
    `&reverse=true` +
    `&access_token=${encodeURIComponent(connection.accessToken)}`;

  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classifyMetaError(res, body);

  const replies = Array.isArray(body?.data) ? body.data : [];
  return {
    draftId: draft.id,
    threadId: draft.externalPostId,
    fetchedAt: new Date().toISOString(),
    replies: replies.map((r) => ({
      replyId: String(r.id),
      text: r.text ?? null,
      author: r.username ? `@${r.username}` : null,
      timestamp: r.timestamp ?? null,
      permalink: r.permalink ?? null,
      hidden: r.hide_status === "HIDDEN",
    })),
  };
}

// Toggle a reply's hidden state. Only an explicit user action should
// hit this — never an automated process.
export async function setReplyHidden({ draftId, clientId, replyId, hide, actorSub }) {
  // Validate the draft + connection, but we don't strictly need to
  // confirm the reply belongs to the draft — Meta enforces that at
  // the API level (you can only hide replies on threads you own).
  await getDraftWithThreadId({ draftId, clientId });
  const connection = await getThreadsConnection(clientId);

  if (typeof hide !== "boolean") {
    throw new ThreadsRepliesError("hide must be a boolean", {
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(replyId)}/manage_reply`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      hide: hide ? "true" : "false",
      access_token: connection.accessToken,
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classifyMetaError(res, body);

  logger.info(
    { clientId, draftId, replyId, hide, actor: actorSub ?? null },
    "[THREADS_REPLIES] reply visibility changed"
  );

  return { replyId: String(replyId), hidden: hide, success: body?.success !== false };
}
