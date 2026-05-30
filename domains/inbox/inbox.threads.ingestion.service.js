// SquadInbox — Threads reply ingestion.
//
// Counterpart to inbox.youtube.ingestion.service.js for the
// Threads public-reply surface. This file ONLY handles persistence
// — turning a normalized reply payload into a Conversation +
// Message + Contact in the Inbox graph.
//
// What's deliberately NOT here:
//   - OAuth flow + token storage (lives in
//     domains/studio/oauth/threads.oauth.js).
//   - The reply-polling job that enumerates the workspace's
//     published Threads posts and calls /conversation per post.
//     That worker lives in
//     domains/inbox/threadsReplyPoller.service.js.
//   - The reply send path. Threads' "post a reply" uses the
//     existing publish pipeline with replied_to=<id>; we keep
//     that gated behind THREADS_REPLY_ENABLED for now and
//     surface a truthful "Threads reply publishing is not
//     enabled" reason in the resolver until it's wired.
//
// Capability posture (spinstr417):
//   - Tenant resolution: threadsUserId → matches a ChannelConnection
//     with channel=THREADS and externalAccountId=<user id>.
//   - Idempotent on Threads reply id. Re-walking the same /conversation
//     page on every tick is safe — second call returns the existing
//     message id.
//   - Visibility = PUBLIC, sourceType = SOCIAL_COMMENT,
//     provider = THREADS. UI branches on sourceType to render
//     "Threads reply" framing; AI prompt branches into public-
//     comment-safe voice on visibility=PUBLIC.
//   - Replier email/phone is never exposed by Threads' API. We
//     identify the replier by their Threads user id (when
//     present) or their @username, stored on
//     Contact.enrichmentJson.externalIds.THREADS.
//   - Own-account echo guard: replies authored by the connected
//     Threads user are dropped at ingest time so the inbox
//     doesn't show "you replied to yourself".

import { prisma } from "../../prisma.js";

/**
 * Persist a single normalized Threads reply.
 *
 * @param {object} reply — normalized shape (see below)
 * @returns {Promise<{ status: 'created' | 'duplicate' | 'skipped',
 *                     reason?: string,
 *                     conversationId?: string,
 *                     messageId?: string }>}
 *
 * Normalized reply shape (what the poller hands us):
 *   {
 *     threadsUserId:  "12345",                 // workspace's TH user id
 *     postId:         "ti_abc",                // root Threads post id
 *     postTitle:      "Open house this Sun…",  // short preview (we extract)
 *     replyId:        "ti_reply_001",          // top-level OR nested
 *     parentId:       null | "ti_other",       // null when reply-to-post
 *     text:           "Is this still available?",
 *     author: {
 *       userId:      "67890" | null,           // replier's TH user id
 *       username:    "danielw" | null,         // no leading @
 *     },
 *     timestamp:      "2026-05-16T10:00:00Z",
 *     permalink:      "https://www.threads.net/@danielw/post/..." | null,
 *   }
 */
export async function ingestThreadsReply(reply) {
  if (!reply || typeof reply !== "object") {
    return { status: "skipped", reason: "BAD_PAYLOAD" };
  }
  const { threadsUserId, postId, postTitle, replyId, parentId, text, author, timestamp, permalink } =
    reply;

  if (!threadsUserId || typeof threadsUserId !== "string") {
    return { status: "skipped", reason: "MISSING_USER" };
  }
  if (!postId || typeof postId !== "string") {
    return { status: "skipped", reason: "MISSING_POST" };
  }
  if (!replyId || typeof replyId !== "string") {
    return { status: "skipped", reason: "MISSING_REPLY_ID" };
  }

  const conn = await findThreadsConnection(threadsUserId);
  if (!conn) {
    return { status: "skipped", reason: "UNKNOWN_ACCOUNT" };
  }

  // Own-author echo guard. Threads' /conversation returns every
  // reply on the thread, including ones authored by the connected
  // user (e.g. "thanks!" reply from the page itself). We never
  // want to surface those as inbound conversations.
  const authorUserId = author?.userId ? String(author.userId) : null;
  if (authorUserId && authorUserId === threadsUserId) {
    return { status: "skipped", reason: "OWN_AUTHOR" };
  }

  // Idempotency check — same reply id arriving twice (poller ran
  // twice, retry after error, /conversation paged differently)
  // must NOT duplicate the Message.
  const existing = await prisma.message.findFirst({
    where: {
      externalMessageId: replyId,
      conversation: { clientId: conn.clientId, provider: "THREADS" },
    },
    select: { id: true, conversationId: true },
  });
  if (existing) {
    return {
      status: "duplicate",
      conversationId: existing.conversationId,
      messageId: existing.id,
    };
  }

  const contact = await findOrCreateAuthorContact({
    clientId: conn.clientId,
    author,
  });

  // One conversation per POST × REPLIER. A reply-to-reply from
  // the same author collapses into the existing thread; a
  // different author on the same post gets their own row.
  const authorKey =
    authorUserId ?? `anon:${(author?.username ?? "viewer").slice(0, 64)}`;
  const externalThreadId = `${postId}:${authorKey}`;
  const createdAt = parseDate(timestamp);

  let conversation = await prisma.conversation.findFirst({
    where: {
      clientId: conn.clientId,
      provider: "THREADS",
      externalThreadId,
    },
    select: { id: true },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        clientId: conn.clientId,
        contactId: contact.id,
        sourceType: "SOCIAL_COMMENT",
        provider: "THREADS",
        externalThreadId,
        pageId: null,
        campaignId: null,
        status: "OPEN",
        lastMessageAt: createdAt,
        lastMessageFrom: "CONTACT",
      },
      select: { id: true },
    });
  } else {
    await prisma.conversation
      .update({
        where: { id: conversation.id },
        data: { lastMessageAt: createdAt, lastMessageFrom: "CONTACT", status: "OPEN" },
      })
      .catch(() => {});
  }

  const body = renderReplyBody({ text, postTitle, isNested: Boolean(parentId) });

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      party: "CONTACT",
      channel: "SOCIAL_DM",
      body,
      payloadJson: sanitizeReplyPayload(reply),
      externalMessageId: replyId,
      providerMessageId: replyId,
      visibility: "PUBLIC",
      sourceUrl: typeof permalink === "string" ? permalink : null,
      deliveryStatus: "SENT",
      createdAt,
    },
  });

  console.log("[threads.inbox] ingested reply →", {
    clientId: conn.clientId,
    threadsUserId,
    postId,
    replyId,
    parentId,
    isNested: Boolean(parentId),
    conversationId: conversation.id,
    messageId: message.id,
  });

  return {
    status: "created",
    conversationId: conversation.id,
    messageId: message.id,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

async function findThreadsConnection(threadsUserId) {
  if (!threadsUserId) return null;
  const candidates = await prisma.channelConnection.findMany({
    where: {
      channel: "THREADS",
      externalAccountId: threadsUserId,
      status: "CONNECTED",
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, clientId: true, channel: true, scopes: true, updatedAt: true },
  });
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    console.warn("[threads.inbox] multiple workspaces have this Threads user connected:", {
      threadsUserId,
      candidates: candidates.map((c) => ({ clientId: c.clientId, updatedAt: c.updatedAt })),
      picked: candidates[0].clientId,
    });
  }
  return candidates[0];
}

async function findOrCreateAuthorContact({ clientId, author }) {
  // Threads doesn't surface replier email/phone. Identify by
  // their Threads user id when present; otherwise synthesize a
  // stable id from the @username so re-runs collapse to the same
  // row instead of spawning a new contact per poll.
  const id =
    typeof author?.userId === "string" && author.userId.length > 0
      ? author.userId
      : typeof author?.username === "string" && author.username.length > 0
        ? `username:${author.username}`
        : `anon:Threads viewer`;
  const displayName =
    typeof author?.username === "string" && author.username.trim().length > 0
      ? `@${author.username.trim()}`
      : "Threads viewer";

  const existing = await prisma.contact.findFirst({
    where: {
      clientId,
      enrichmentJson: {
        path: ["externalIds", "THREADS"],
        equals: id,
      },
    },
  });
  if (existing) return existing;

  return prisma.contact.create({
    data: {
      clientId,
      email: null,
      phone: null,
      name: displayName,
      firstSeenVia: "SOCIAL",
      status: "NEW",
      enrichmentJson: {
        externalIds: { THREADS: id },
        firstSeenProvider: "THREADS",
        threadsUsername:
          typeof author?.username === "string" ? author.username : null,
      },
    },
  });
}

// Body composition — prefix with the post preview when present so
// the Inbox preview shows what the reply is on without needing to
// load the parent payload.
function renderReplyBody({ text, postTitle, isNested }) {
  const trimmed = typeof text === "string" ? text.trim().slice(0, 4000) : "";
  const safe = trimmed || "(empty reply)";
  if (postTitle) {
    const verb = isNested ? "Nested reply on" : "Reply on";
    return `${verb} "${String(postTitle).slice(0, 120)}"\n\n${safe}`;
  }
  return safe;
}

function sanitizeReplyPayload(reply) {
  if (!reply || typeof reply !== "object") return null;
  return {
    replyId: typeof reply.replyId === "string" ? reply.replyId : null,
    parentId: typeof reply.parentId === "string" ? reply.parentId : null,
    postId: typeof reply.postId === "string" ? reply.postId : null,
    postTitle: typeof reply.postTitle === "string" ? reply.postTitle : null,
    threadsUserId:
      typeof reply.threadsUserId === "string" ? reply.threadsUserId : null,
    timestamp: typeof reply.timestamp === "string" ? reply.timestamp : null,
    author: reply.author
      ? {
          userId: typeof reply.author.userId === "string" ? reply.author.userId : null,
          username:
            typeof reply.author.username === "string" ? reply.author.username : null,
        }
      : null,
  };
}

function parseDate(raw) {
  if (!raw) return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
