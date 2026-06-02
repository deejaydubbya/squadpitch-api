// SquadInbox — shared Facebook/Instagram comment ingestion.
//
// Polling-friendly persistence layer for FB Page comments and IG
// comments. Extracted from the now-removed Meta webhook receiver
// (`inbox.meta.webhook.routes.js` + `inbox.meta.ingestion.service.js`)
// so the polling services in prompt 02 can call the same idempotent
// upsert without re-implementing it per-channel.
//
// Why this module exists rather than per-channel duplication:
//   - The Inbox graph (Conversation/Message/Contact) treats FB Page
//     comments and IG comments the same way — one Conversation per
//     post (keyed by externalThreadId = parentPostId), one Message
//     per comment (keyed by externalMessageId = commentId). Both
//     channels resolve a workspace by ChannelConnection.externalAccountId.
//   - Keeping the persistence shape in one place means a change to
//     the visibility rule / contact dedupe / spam handling doesn't
//     have to be made twice and stay in sync.
//
// Capability posture (post-Meta-webhook removal, June 2026):
//   - Comments only. Requires pages_read_user_content +
//     pages_manage_engagement (FB Page comments) and
//     instagram_business_manage_comments (IG comments under the
//     Instagram Business Login product). Private DMs explicitly OUT
//     of scope — no pages_messaging / instagram_business_manage_messages.
//   - Reply send paths live in inbox.outbound.facebook.service.js /
//     inbox.outbound.instagram.service.js. They write
//     externalMessageId = the provider reply id so the polling
//     ingester's idempotency check filters them out as duplicates
//     instead of re-creating them as inbound messages.
//
// Idempotency: Message.externalMessageId is the provider comment id.
// A repeated upsert for the same comment returns { status: 'duplicate' }
// without writing.
//
// PII rules: same as the legacy module — store commenter id +
// display name (already public on the post), no email/phone (Meta
// doesn't surface them for comment authors), store comment body
// verbatim as Message.body (in scope, it's public content).

import { prisma } from "../../prisma.js";

/**
 * Idempotently persist a normalized FB/IG comment into the Inbox
 * graph. Polling adapters in prompt 02 are expected to call this
 * per-comment after fetching from Graph; the function handles
 * Contact lookup-or-create, Conversation lookup-or-create, the
 * Message insert, and the conversation activity bump.
 *
 * @param {object} args
 * @param {string} args.clientId — workspace owning the Channel.
 * @param {"FACEBOOK"|"INSTAGRAM"} args.provider
 * @param {string} args.externalAccountId — FB page id / IG user id
 *   the comment is attached to. Used only for log diagnostics; the
 *   workspace is determined by `clientId`. Polling callers will
 *   typically have resolved this via `findConnectionForAccount`.
 * @param {string} args.commentId — provider comment id (FB
 *   comment_id / IG comment id). Used as Message.externalMessageId
 *   for idempotency.
 * @param {string|null} args.parentPostId — id of the post the
 *   comment was made on. Conversations are keyed per-post so a
 *   thread groups every commenter on the same post.
 * @param {string|null} args.parentCommentId — comment id of the
 *   parent comment for nested replies. Not currently used for
 *   threading (we group by post), but persisted in the raw payload
 *   so a future per-thread grouping can be added without backfill.
 * @param {string} args.body — comment text.
 * @param {string|null} args.fromId — provider user id of the
 *   commenter.
 * @param {string|null} args.fromName — display name / @username.
 * @param {string|null} args.permalink — public URL to the comment.
 * @param {string|number|null} args.createdAtRaw — provider-supplied
 *   creation time (ISO string or unix seconds). Parsed defensively;
 *   falls back to `new Date()` on bad input.
 * @param {object|null} args.rawValue — full provider payload for
 *   the comment. Whitelisted to safe fields before storing.
 * @returns {Promise<{status: 'created'|'duplicate'|'skipped', conversationId?: string, messageId?: string, reason?: string}>}
 */
export async function upsertExternalCommentMessage({
  clientId,
  provider,
  externalAccountId,
  commentId,
  parentPostId,
  parentCommentId,
  body,
  fromId,
  fromName,
  permalink,
  createdAtRaw,
  rawValue,
}) {
  if (!commentId || typeof commentId !== "string") {
    return { status: "skipped", reason: "MISSING_COMMENT_ID" };
  }
  if (!clientId || typeof clientId !== "string") {
    return { status: "skipped", reason: "MISSING_CLIENT_ID" };
  }
  if (provider !== "FACEBOOK" && provider !== "INSTAGRAM") {
    return { status: "skipped", reason: `UNSUPPORTED_PROVIDER:${provider}` };
  }

  // Idempotency check — same comment arriving twice (polling overlap
  // is the rule, not the exception) must not duplicate the Message
  // row. We key by Message.externalMessageId because the comment id
  // is globally unique within a provider.
  const existing = await prisma.message.findFirst({
    where: {
      externalMessageId: commentId,
      conversation: { clientId, provider },
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

  // Contact lookup or creation. Meta comment authors don't carry
  // email/phone — we identify them by their Meta user id stored
  // in Contact.enrichmentJson.externalIds[<PROVIDER>]. JSON path
  // query for the lookup; creates a new row when no match.
  const contact = fromId
    ? await findOrCreateMetaContact({
        clientId,
        provider,
        externalUserId: fromId,
        displayName: fromName,
      })
    : null;
  if (!contact) {
    return { status: "skipped", reason: "MISSING_FROM_ID" };
  }

  const createdAt = parseMetaDate(createdAtRaw);

  // Conversation lookup. One Conversation per (page-post or
  // media-post), keyed by externalThreadId = parentPostId. Groups
  // every commenter on the same post into one inbox thread — easier
  // for the workspace user to triage than one thread per commenter.
  //
  // Falls back to one-thread-per-comment-author when there's no post
  // id (rare, but Meta has edge cases — orphaned reply notifications,
  // etc).
  const threadKey = parentPostId ?? `orphan:${commentId}`;
  let conversation = await prisma.conversation.findFirst({
    where: { clientId, provider, externalThreadId: threadKey },
    select: { id: true, contactId: true, status: true, spam: true },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        clientId,
        contactId: contact.id,
        sourceType: "SOCIAL",
        provider,
        externalThreadId: threadKey,
        // No pageId/campaignId for social comments — they're not
        // SquadSites pages.
        pageId: null,
        campaignId: null,
        status: "OPEN",
        lastMessageAt: createdAt,
        lastMessageFrom: "CONTACT",
      },
      select: { id: true, contactId: true, status: true, spam: true },
    });
  }

  // Skip writing on spam-marked threads. The polling caller logs
  // the skip but doesn't retry — same shape the webhook receiver
  // used so Meta would stop hammering us.
  if (conversation.spam) {
    return { status: "skipped", reason: "CONVERSATION_SPAM" };
  }

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      party: "CONTACT",
      channel: "SOCIAL_DM", // closest existing MessageChannel; comment-specific channel can come later
      body: typeof body === "string" ? body.slice(0, 4000) : "",
      payloadJson: sanitizeRawComment(rawValue, { parentCommentId }),
      externalMessageId: commentId,
      providerMessageId: commentId,
      visibility: "PUBLIC",
      sourceUrl: typeof permalink === "string" ? permalink : null,
      deliveryStatus: "SENT", // received side of an already-delivered envelope
      createdAt,
    },
  });

  // Bump conversation activity. workspaceReadAt is deliberately
  // NOT touched so the unread badge fires.
  if (
    !conversation.lastMessageAt ||
    new Date(conversation.lastMessageAt).getTime() < createdAt.getTime()
  ) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: createdAt,
        lastMessageFrom: "CONTACT",
      },
    });
  }

  // Diagnostic — surfaces exactly which workspace the conversation
  // landed in. Helpful when multiple workspaces have the same
  // ChannelConnection.externalAccountId (rare, but possible after
  // OAuth re-connections across workspaces).
  console.log("[meta.inbox] ingested →", {
    clientId,
    provider,
    pageOrIgId: externalAccountId,
    conversationId: conversation.id,
    messageId: message.id,
    externalThreadId: threadKey,
    externalMessageId: commentId,
  });

  return {
    status: "created",
    conversationId: conversation.id,
    messageId: message.id,
  };
}

/**
 * Resolve which workspace owns a given FB Page / IG Business
 * account. The polling worker is expected to call this once per
 * connection in its dispatch loop — same shape the legacy webhook
 * receiver used, so a connection migrated mid-poll behaves the
 * same way it did mid-webhook.
 *
 * Same FB page / IG account can be wired to multiple workspaces
 * (e.g. an old/orphaned workspace still has a connection row
 * alongside a freshly-OAuth'd active workspace). When that
 * happens, return whichever connection was used most recently —
 * that's almost certainly the one the user expects events to flow
 * into. `updatedAt` bumps on every OAuth, every token refresh, and
 * every publish (via lastValidatedAt write), so it's a good
 * "recently active" signal. Logs a warning when multiple rows are
 * found so the ambiguity is visible to ops.
 *
 * @param {object} args
 * @param {"FACEBOOK"|"INSTAGRAM"} args.channel
 * @param {string|null|undefined} args.externalAccountId
 * @returns {Promise<{id: string, clientId: string, channel: string, scopes: string[], updatedAt: Date}|null>}
 */
export async function findConnectionForAccount({ channel, externalAccountId }) {
  if (!externalAccountId) return null;
  const candidates = await prisma.channelConnection.findMany({
    where: {
      channel,
      externalAccountId,
      status: "CONNECTED",
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      clientId: true,
      channel: true,
      scopes: true,
      updatedAt: true,
    },
  });
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    console.warn("[meta.inbox] multiple workspaces have this account connected:", {
      channel,
      externalAccountId,
      candidates: candidates.map((c) => ({
        clientId: c.clientId,
        updatedAt: c.updatedAt,
      })),
      picked: candidates[0].clientId,
    });
  }
  return candidates[0];
}

/**
 * Look up a Contact by the Meta user id stored in
 * `enrichmentJson.externalIds.<PROVIDER>`. If no match, create a
 * new Contact with email/phone null — social commenters don't have
 * either. clientId scoping is enforced.
 *
 * Exported so the polling adapters can pre-create contacts in
 * batch if they ever need to (e.g. backfilling a workspace's
 * historical comment authors). Today the caller is
 * `upsertExternalCommentMessage` itself.
 *
 * @param {object} args
 * @param {string} args.clientId
 * @param {"FACEBOOK"|"INSTAGRAM"} args.provider
 * @param {string} args.externalUserId — Meta user id (commenter).
 * @param {string|null|undefined} args.displayName
 * @returns {Promise<{id: string, clientId: string, name: string|null, enrichmentJson: object}>}
 */
export async function findOrCreateMetaContact({
  clientId,
  provider,
  externalUserId,
  displayName,
}) {
  // Prisma's Json path filter — finds rows where enrichmentJson
  // has a top-level externalIds.<provider> equal to externalUserId.
  // Postgres-only; Postgres is the production DB.
  const existing = await prisma.contact.findFirst({
    where: {
      clientId,
      enrichmentJson: {
        path: ["externalIds", provider],
        equals: externalUserId,
      },
    },
  });
  if (existing) return existing;

  return prisma.contact.create({
    data: {
      clientId,
      email: null,
      phone: null,
      name: displayName ?? null,
      firstSeenVia: "SOCIAL",
      status: "NEW",
      enrichmentJson: {
        externalIds: { [provider]: externalUserId },
        firstSeenProvider: provider,
      },
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

// Whitelist what we keep from the raw provider payload. NO full
// payload echoes — the schema's payloadJson can hold any JSON but
// we limit what lands there so future migrations don't have to
// reckon with arbitrary Meta payload shape changes. Accepts an
// optional `parentCommentId` extracted by the caller (polling
// payloads vary in shape between FB Graph and IG Graph; the caller
// normalizes once at the call site so this function stays uniform).
function sanitizeRawComment(value, { parentCommentId } = {}) {
  if (!value || typeof value !== "object") {
    if (typeof parentCommentId === "string") return { parent_id: parentCommentId };
    return null;
  }
  const safe = {};
  if (typeof value.comment_id === "string") safe.comment_id = value.comment_id;
  if (typeof value.id === "string") safe.id = value.id;
  if (typeof value.post_id === "string") safe.post_id = value.post_id;
  if (typeof value.parent_id === "string") safe.parent_id = value.parent_id;
  else if (typeof parentCommentId === "string") safe.parent_id = parentCommentId;
  if (
    typeof value.created_time === "string" ||
    typeof value.created_time === "number"
  ) {
    safe.created_time = value.created_time;
  }
  if (typeof value.permalink_url === "string") safe.permalink_url = value.permalink_url;
  if (value.media && typeof value.media === "object") {
    safe.media = {
      id: typeof value.media.id === "string" ? value.media.id : null,
      permalink:
        typeof value.media.permalink === "string" ? value.media.permalink : null,
    };
  }
  if (value.from && typeof value.from === "object") {
    safe.from = {
      id: typeof value.from.id === "string" ? value.from.id : null,
      // Username for IG, name for FB — both are public display labels.
      username:
        typeof value.from.username === "string" ? value.from.username : undefined,
      name: typeof value.from.name === "string" ? value.from.name : undefined,
    };
  }
  return safe;
}

function parseMetaDate(raw) {
  if (raw === null || raw === undefined) return new Date();
  // Meta sometimes returns ISO strings, sometimes unix seconds.
  if (typeof raw === "number") {
    const ms = raw > 1e12 ? raw : raw * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  if (typeof raw === "string") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  return new Date();
}
