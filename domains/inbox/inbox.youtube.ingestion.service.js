// SquadInbox — YouTube comment ingestion.
//
// Counterpart to inbox.gbp.ingestion.service.js for the YouTube
// public-comment surface. This file ONLY handles persistence —
// turning a normalized comment payload into a Conversation +
// Message + Contact in the Inbox graph.
//
// What's deliberately NOT here:
//   - OAuth flow + token storage (lives in
//     domains/studio/oauth/youtube.oauth.js).
//   - The comment-polling job that enumerates the workspace's
//     published videos and calls commentThreads.list per video.
//     That worker lives in domains/inbox/youtubeCommentPoller.service.js
//     and ultimately calls ingestYouTubeComment() in a loop.
//   - The comments.insert send path. Lives in
//     domains/inbox/inbox.outbound.youtube.service.js when the
//     resolver flips REPLY_PUBLIC_COMMENT to available (requires
//     youtube.force-ssl on the granted scope set).
//
// Capability posture (spinstr416):
//   - Tenant resolution: channelId → matches a ChannelConnection
//     with channel=YOUTUBE and externalAccountId=<youtube channel id>.
//     Unknown channels return reason=UNKNOWN_ACCOUNT (caller logs).
//   - Idempotent on YouTube comment id (top-level commentThread or
//     individual reply). Re-fetching the same page on every tick is
//     safe — second call returns the existing message id.
//   - Visibility = PUBLIC, sourceType = SOCIAL_COMMENT,
//     provider = YOUTUBE. The UI branches on sourceType to render
//     "YouTube comment" framing; the AI prompt branches into
//     public-comment-safe voice on visibility=PUBLIC.
//   - Commenter email/phone is never exposed by YouTube's API.
//     We identify the commenter by their authorChannelId stored on
//     Contact.enrichmentJson.externalIds.YOUTUBE.

import { prisma } from "../../prisma.js";

/**
 * Persist a single normalized YouTube comment.
 *
 * @param {object} comment — normalized shape (see below)
 * @returns {Promise<{ status: 'created' | 'duplicate' | 'skipped',
 *                     reason?: string,
 *                     conversationId?: string,
 *                     messageId?: string }>}
 *
 * Normalized comment shape (what the poller hands us):
 *   {
 *     channelId:    "UCabc123",                  // workspace's YT channel
 *     videoId:      "dQw4w9WgXcQ",               // video the comment is on
 *     videoTitle:   "Spring open house highlights",
 *     commentId:    "Ugxyz...",                  // top-level OR reply id
 *     parentId:     null | "Ugxyz...",           // null when top-level
 *     text:         "Loved this place!",
 *     author: {
 *       channelId:   "UCxyz" | null,             // commenter's channel id
 *       displayName: "Daniel Wardlow",
 *       profileImageUrl: "https://..." | null,
 *     },
 *     publishedAt:  "2026-05-16T10:00:00Z",
 *     sourceUrl:    "https://www.youtube.com/watch?v=...&lc=Ugxyz...",
 *   }
 */
export async function ingestYouTubeComment(comment) {
  if (!comment || typeof comment !== "object") {
    return { status: "skipped", reason: "BAD_PAYLOAD" };
  }
  const { channelId, videoId, videoTitle, commentId, parentId, text, author, publishedAt, sourceUrl } =
    comment;

  if (!channelId || typeof channelId !== "string") {
    return { status: "skipped", reason: "MISSING_CHANNEL" };
  }
  if (!videoId || typeof videoId !== "string") {
    return { status: "skipped", reason: "MISSING_VIDEO" };
  }
  if (!commentId || typeof commentId !== "string") {
    return { status: "skipped", reason: "MISSING_COMMENT_ID" };
  }

  const conn = await findYouTubeConnection(channelId);
  if (!conn) {
    return { status: "skipped", reason: "UNKNOWN_ACCOUNT" };
  }

  // Don't ingest the workspace's own replies — when an authenticated
  // user replies via comments.insert, that comment appears in the
  // next commentThreads.list page with author.channelId === channelId.
  // We already wrote that message ourselves at send time; re-ingesting
  // would create a duplicate row with party=CONTACT instead of USER.
  if (author?.channelId && author.channelId === channelId) {
    return { status: "skipped", reason: "OWN_AUTHOR" };
  }

  // Idempotency check — same comment id arriving twice (poller
  // ran twice, retry after error, top-level surfaced once then
  // again with replies, etc.) must NOT duplicate the Message.
  const existing = await prisma.message.findFirst({
    where: {
      externalMessageId: commentId,
      conversation: { clientId: conn.clientId, provider: "YOUTUBE" },
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

  // One conversation per VIDEO × COMMENT-AUTHOR. A reply on the
  // same video from the same person collapses into the existing
  // thread; a different author on the same video gets their own row.
  const externalThreadId = `${videoId}:${author?.channelId ?? `anon:${(author?.displayName ?? "viewer").slice(0, 64)}`}`;
  const createdAt = parseDate(publishedAt);

  // Look up an existing conversation by the thread key so a reply
  // to a previously-ingested top-level comment lands on the same row.
  let conversation = await prisma.conversation.findFirst({
    where: {
      clientId: conn.clientId,
      provider: "YOUTUBE",
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
        provider: "YOUTUBE",
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
    // Bump lastMessageAt so the Inbox list resorts on reply.
    await prisma.conversation
      .update({
        where: { id: conversation.id },
        data: { lastMessageAt: createdAt, lastMessageFrom: "CONTACT", status: "OPEN" },
      })
      .catch(() => {});
  }

  const body = renderCommentBody({ text, videoTitle, isReply: Boolean(parentId) });

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      party: "CONTACT",
      // Closest existing MessageChannel — SOCIAL_DM is the bucket
      // we use for any social-network-sourced message. The
      // sourceType=SOCIAL_COMMENT on the conversation is what the
      // UI + AI prompt branch on, not message.channel.
      channel: "SOCIAL_DM",
      body,
      payloadJson: sanitizeCommentPayload(comment),
      externalMessageId: commentId,
      providerMessageId: commentId,
      visibility: "PUBLIC",
      sourceUrl: typeof sourceUrl === "string" ? sourceUrl : null,
      deliveryStatus: "SENT",
      createdAt,
    },
  });

  console.log("[youtube.inbox] ingested comment →", {
    clientId: conn.clientId,
    channelId,
    videoId,
    commentId,
    parentId,
    isReply: Boolean(parentId),
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

async function findYouTubeConnection(channelId) {
  if (!channelId) return null;
  // Same multi-workspace tie-breaker as the GBP / Meta ingestion
  // services — prefer the most recently active connection if two
  // workspaces somehow point at the same YouTube channel.
  const candidates = await prisma.channelConnection.findMany({
    where: {
      channel: "YOUTUBE",
      externalAccountId: channelId,
      status: "CONNECTED",
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, clientId: true, channel: true, scopes: true, updatedAt: true },
  });
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    console.warn("[youtube.inbox] multiple workspaces have this channel connected:", {
      channelId,
      candidates: candidates.map((c) => ({ clientId: c.clientId, updatedAt: c.updatedAt })),
      picked: candidates[0].clientId,
    });
  }
  return candidates[0];
}

async function findOrCreateAuthorContact({ clientId, author }) {
  // YouTube doesn't surface commenter email/phone. Identify by
  // their channel id; anonymized commenters (rare — YouTube
  // requires a Google account) get a synthesized id from the
  // displayName so re-runs collapse to the same row.
  const channelId =
    typeof author?.channelId === "string" && author.channelId.length > 0
      ? author.channelId
      : `anon:${(author?.displayName ?? "YouTube viewer").slice(0, 64)}`;
  const displayName =
    typeof author?.displayName === "string" && author.displayName.trim().length > 0
      ? author.displayName.trim()
      : "YouTube viewer";

  const existing = await prisma.contact.findFirst({
    where: {
      clientId,
      enrichmentJson: {
        path: ["externalIds", "YOUTUBE"],
        equals: channelId,
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
        externalIds: { YOUTUBE: channelId },
        firstSeenProvider: "YOUTUBE",
        profileImageUrl:
          typeof author?.profileImageUrl === "string" ? author.profileImageUrl : null,
      },
    },
  });
}

// Body composition — prefix with the video title when present so the
// Inbox preview shows what the comment is on without needing to load
// the parent payload. Indicates "Reply on" for nested replies.
function renderCommentBody({ text, videoTitle, isReply }) {
  const trimmed = typeof text === "string" ? text.trim().slice(0, 4000) : "";
  const safe = trimmed || "(empty comment)";
  if (videoTitle) {
    const verb = isReply ? "Reply on" : "Comment on";
    return `${verb} "${String(videoTitle).slice(0, 120)}"\n\n${safe}`;
  }
  return safe;
}

// Whitelist what we keep from the raw comment payload — never echo
// arbitrary YouTube API responses into payloadJson.
function sanitizeCommentPayload(comment) {
  if (!comment || typeof comment !== "object") return null;
  return {
    commentId: typeof comment.commentId === "string" ? comment.commentId : null,
    parentId: typeof comment.parentId === "string" ? comment.parentId : null,
    videoId: typeof comment.videoId === "string" ? comment.videoId : null,
    videoTitle: typeof comment.videoTitle === "string" ? comment.videoTitle : null,
    channelId: typeof comment.channelId === "string" ? comment.channelId : null,
    publishedAt: typeof comment.publishedAt === "string" ? comment.publishedAt : null,
    author: comment.author
      ? {
          channelId:
            typeof comment.author.channelId === "string" ? comment.author.channelId : null,
          displayName:
            typeof comment.author.displayName === "string" ? comment.author.displayName : null,
          profileImageUrl:
            typeof comment.author.profileImageUrl === "string"
              ? comment.author.profileImageUrl
              : null,
        }
      : null,
  };
}

function parseDate(raw) {
  if (!raw) return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
