// SquadInbox — Google Business Profile review ingestion.
//
// Counterpart to inbox.metaCommentIngestion.service.js for the
// Google Business Profile "Reviews" surface. This file ONLY handles the
// persistence layer — turning a normalized review payload into a
// Conversation + Message + Contact in the Inbox graph.
//
// What's deliberately NOT here:
//   - OAuth flow + token storage (would live in
//     domains/studio/oauth/googleBusinessProfile.oauth.js once
//     the Google sensitive-scope verification for business.manage
//     lands — see docs/inbox-provider-capabilities.md).
//   - The actual reviews-polling job that calls
//     accounts.locations.reviews.list on a cron. That worker will
//     fetch reviews from Google, normalize each one, and call
//     ingestGbpReview() in a loop.
//   - The reviews.updateReply send path.
//
// Capability posture (spinstr11):
//   - Tenant resolution: locationName → matches a
//     ChannelConnection with channel=GOOGLE_BUSINESS_PROFILE and
//     externalAccountId=<location resource name>. Unknown
//     locations return reason=UNKNOWN_ACCOUNT (200 OK to the
//     caller; logged for audit).
//   - Idempotent on review.name (Meta-formatted resource name
//     "accounts/{a}/locations/{l}/reviews/{r}"). A second call
//     with the same id returns the existing Message.
//   - Visibility = PUBLIC (reviews are on the public surface).
//   - Reviewer email/phone is NEVER provided by the Reviews API.
//     We identify the reviewer by Google profile id stored in
//     Contact.enrichmentJson.externalIds.GOOGLE_BUSINESS.

import { prisma } from "../../prisma.js";

/**
 * Persist a single normalized GBP review.
 *
 * @param {object} review — normalized shape (see Normalized review below)
 * @returns {Promise<{ status: 'created' | 'duplicate' | 'skipped',
 *                     reason?: string,
 *                     conversationId?: string,
 *                     messageId?: string }>}
 *
 * Normalized review shape (what the future poller will hand us):
 *   {
 *     locationName: "accounts/123/locations/456",  // Google's resource name
 *     reviewId:     "accounts/123/locations/456/reviews/789",
 *     starRating:   1..5,
 *     comment:      "...",                          // may be null for star-only
 *     reviewer: {
 *       googleId:    "abc",                         // opaque profile id
 *       displayName: "Daniel Wardlow",              // or "A Google User" anon
 *       isAnonymous: false,
 *     },
 *     createTime:   "2026-05-16T10:00:00Z",
 *     updateTime:   "2026-05-16T10:00:00Z",
 *     reviewReply:  null | { comment, updateTime }, // existing reply, if any
 *     sourceUrl:    "https://search.google.com/local/reviews?..." | null,
 *   }
 */
export async function ingestGbpReview(review) {
  if (!review || typeof review !== "object") {
    return { status: "skipped", reason: "BAD_PAYLOAD" };
  }
  const { locationName, reviewId, comment, starRating, reviewer, createTime, sourceUrl } =
    review;

  if (!locationName || typeof locationName !== "string") {
    return { status: "skipped", reason: "MISSING_LOCATION" };
  }
  if (!reviewId || typeof reviewId !== "string") {
    return { status: "skipped", reason: "MISSING_REVIEW_ID" };
  }

  const conn = await findGbpConnection(locationName);
  if (!conn) {
    return { status: "skipped", reason: "UNKNOWN_ACCOUNT" };
  }

  // Idempotency check — same review id arriving twice (poller
  // ran twice, retry after error, etc.) must NOT duplicate the
  // Message. We key by externalMessageId scoped to this client
  // + provider.
  const existing = await prisma.message.findFirst({
    where: {
      externalMessageId: reviewId,
      conversation: { clientId: conn.clientId, provider: "GOOGLE_BUSINESS" },
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

  const contact = await findOrCreateReviewerContact({
    clientId: conn.clientId,
    reviewer,
  });

  // One conversation per LOCATION × REVIEWER pair. Each reviewer
  // typically has at most one review per location, so this is
  // 1:1 in practice — but the model handles edits + reply
  // threading cleanly if a reviewer updates their review later.
  const threadKey = `${locationName}:${reviewer?.googleId ?? "anon"}:${reviewId}`;
  const createdAt = parseDate(createTime);

  const conversation = await prisma.conversation.create({
    data: {
      clientId: conn.clientId,
      contactId: contact.id,
      sourceType: "REVIEW",
      provider: "GOOGLE_BUSINESS",
      externalThreadId: threadKey,
      pageId: null,
      campaignId: null,
      status: "OPEN",
      lastMessageAt: createdAt,
      lastMessageFrom: "CONTACT",
    },
    select: { id: true },
  });

  // Body composition — explicit star prefix so the Inbox preview
  // and the AI prompt both see the rating front-and-center even
  // when the reviewer wrote no comment.
  const body = renderReviewBody({ starRating, comment });

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      party: "CONTACT",
      // No dedicated MessageChannel for reviews yet — closest
      // existing value is SOCIAL_DM (used for IG comments too).
      // A future REVIEW channel value would be additive but isn't
      // necessary for the Inbox flow today.
      channel: "SOCIAL_DM",
      body,
      payloadJson: sanitizeReviewPayload(review),
      externalMessageId: reviewId,
      providerMessageId: reviewId,
      visibility: "PUBLIC",
      sourceUrl: typeof sourceUrl === "string" ? sourceUrl : null,
      deliveryStatus: "SENT",
      createdAt,
    },
  });

  console.log("[gbp.inbox] ingested review →", {
    clientId: conn.clientId,
    locationName,
    reviewId,
    starRating,
    hasComment: Boolean(comment),
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

async function findGbpConnection(locationName) {
  if (!locationName) return null;
  // Mirrors the multi-workspace tie-breaker in
  // inbox.metaCommentIngestion.service.js — prefer the most recently
  // active connection if two workspaces somehow point at the
  // same Google location.
  const candidates = await prisma.channelConnection.findMany({
    where: {
      channel: "GOOGLE_BUSINESS_PROFILE",
      externalAccountId: locationName,
      status: "CONNECTED",
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, clientId: true, channel: true, scopes: true, updatedAt: true },
  });
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    console.warn("[gbp.inbox] multiple workspaces have this location connected:", {
      locationName,
      candidates: candidates.map((c) => ({ clientId: c.clientId, updatedAt: c.updatedAt })),
      picked: candidates[0].clientId,
    });
  }
  return candidates[0];
}

async function findOrCreateReviewerContact({ clientId, reviewer }) {
  // No email / phone — Google's Reviews API never surfaces those.
  // Identify by reviewer.googleId stored in
  // enrichmentJson.externalIds.GOOGLE_BUSINESS. Anonymous reviews
  // are still ingested; we just synthesize a stable id from the
  // displayName so re-runs collapse to the same row.
  const googleId =
    typeof reviewer?.googleId === "string" && reviewer.googleId.length > 0
      ? reviewer.googleId
      : `anon:${(reviewer?.displayName ?? "Google reviewer").slice(0, 64)}`;
  const displayName =
    typeof reviewer?.displayName === "string" && reviewer.displayName.trim().length > 0
      ? reviewer.displayName.trim()
      : "Google reviewer";

  const existing = await prisma.contact.findFirst({
    where: {
      clientId,
      enrichmentJson: {
        path: ["externalIds", "GOOGLE_BUSINESS"],
        equals: googleId,
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
        externalIds: { GOOGLE_BUSINESS: googleId },
        firstSeenProvider: "GOOGLE_BUSINESS",
        isAnonymous: Boolean(reviewer?.isAnonymous),
      },
    },
  });
}

// Body composition — star rating prefix so previews + AI prompts
// always have the rating in view, even when the reviewer wrote
// no comment (a "1-star, no text" review is the most common
// case the workspace user wants to triage).
function renderReviewBody({ starRating, comment }) {
  const stars = Number.isFinite(starRating)
    ? `${"★".repeat(Math.max(0, Math.min(5, Math.round(starRating))))}${"☆".repeat(
        Math.max(0, 5 - Math.max(0, Math.min(5, Math.round(starRating)))),
      )}`
    : "";
  const trimmed = typeof comment === "string" ? comment.trim().slice(0, 4000) : "";
  if (stars && trimmed) return `${stars}\n\n${trimmed}`;
  if (stars) return `${stars}\n\n(no comment)`;
  return trimmed || "(no comment)";
}

// Whitelist what we keep from the raw review payload — never echo
// arbitrary Google API responses into payloadJson, even though
// Google's payloads are generally PII-light.
function sanitizeReviewPayload(review) {
  if (!review || typeof review !== "object") return null;
  const out = {
    reviewId: typeof review.reviewId === "string" ? review.reviewId : null,
    locationName: typeof review.locationName === "string" ? review.locationName : null,
    starRating: Number.isFinite(review.starRating) ? review.starRating : null,
    createTime: typeof review.createTime === "string" ? review.createTime : null,
    updateTime: typeof review.updateTime === "string" ? review.updateTime : null,
    reviewer: review.reviewer
      ? {
          googleId: typeof review.reviewer.googleId === "string" ? review.reviewer.googleId : null,
          displayName:
            typeof review.reviewer.displayName === "string" ? review.reviewer.displayName : null,
          isAnonymous: Boolean(review.reviewer.isAnonymous),
        }
      : null,
  };
  if (review.reviewReply && typeof review.reviewReply === "object") {
    out.reviewReply = {
      comment:
        typeof review.reviewReply.comment === "string"
          ? review.reviewReply.comment.slice(0, 4000)
          : null,
      updateTime:
        typeof review.reviewReply.updateTime === "string" ? review.reviewReply.updateTime : null,
    };
  }
  return out;
}

function parseDate(raw) {
  if (!raw) return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
