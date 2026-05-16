// SquadInbox — Meta webhook ingestion.
//
// Converts a Meta webhook payload (Facebook Page comments OR
// Instagram comments) into Conversation + Message rows in the
// Inbox graph.
//
// Capability posture (spinstr10):
//   - Comments only this pass. FB/IG DMs add the 24-hour-window
//     rule and need their own scopes (pages_messaging /
//     instagram_manage_messages); deferred.
//   - Reply send paths NOT implemented. Comments arrive with
//     Message.visibility=PUBLIC and externalMessageId set so a
//     future REPLY_PUBLIC_COMMENT action can call Meta's reply API.
//   - Tenant resolution: the page id / IG user id in the webhook
//     payload maps back to a ChannelConnection.externalAccountId,
//     which carries the clientId. Payloads for unknown accounts
//     200-OK with reason=UNKNOWN_ACCOUNT so Meta stops retrying.
//
// Idempotency: Message.externalMessageId is the Meta comment id.
// A repeated webhook for the same comment returns the existing
// Message row without writing.
//
// PII rules:
//   - We store commenter id + display name (already public on the
//     post). No email, no phone — Meta doesn't surface those for
//     comment authors.
//   - Comment body is stored verbatim as Message.body. That's the
//     same content the comment author wrote publicly; storing it
//     is in scope.

import { prisma } from "../../prisma.js";

/**
 * Top-level dispatcher. Walks the webhook envelope and routes each
 * change/message to the correct ingester. Returns a result summary
 * the route uses for its logging line.
 *
 * @param {object} payload — Meta webhook body (already JSON-parsed)
 * @returns {Promise<{processed: number, created: number, duplicate: number, skipped: number, reasons: string[]}>}
 */
export async function processMetaWebhookPayload(payload) {
  const summary = {
    processed: 0,
    created: 0,
    duplicate: 0,
    skipped: 0,
    reasons: [],
  };
  if (!payload || typeof payload !== "object") {
    summary.skipped += 1;
    summary.reasons.push("BAD_PAYLOAD");
    return summary;
  }
  const object = typeof payload.object === "string" ? payload.object : null;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const accountId = typeof entry?.id === "string" ? entry.id : null;
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    if (object === "page") {
      for (const change of changes) {
        if (change?.field !== "feed") continue;
        const result = await ingestPageFeedChange({
          pageId: accountId,
          value: change.value,
        });
        applyResult(summary, result);
      }
    } else if (object === "instagram") {
      for (const change of changes) {
        if (change?.field !== "comments") continue;
        const result = await ingestInstagramComment({
          igAccountId: accountId,
          value: change.value,
        });
        applyResult(summary, result);
      }
    } else {
      summary.skipped += 1;
      summary.reasons.push(`UNSUPPORTED_OBJECT:${object ?? "null"}`);
    }
  }

  return summary;
}

function applyResult(summary, result) {
  summary.processed += 1;
  if (result.status === "created") summary.created += 1;
  else if (result.status === "duplicate") summary.duplicate += 1;
  else {
    summary.skipped += 1;
    if (result.reason) summary.reasons.push(result.reason);
  }
}

// ── Facebook Page feed change → comment ────────────────────────────────
//
// FB Page webhook delivers comment events under
// `entry[].changes[].field = "feed"` with value.item = "comment".
// Other items (post, reaction, status) are ignored.
async function ingestPageFeedChange({ pageId, value }) {
  if (!pageId || !value || typeof value !== "object") {
    return { status: "skipped", reason: "BAD_PAGE_CHANGE" };
  }
  if (value.item !== "comment") {
    return { status: "skipped", reason: `IGNORED_ITEM:${value.item ?? "null"}` };
  }
  // Echo guard — when the workspace user replies as the Page, FB
  // re-emits a webhook with the SAME page id as the comment's
  // "from". Ignore those: they're our own outbound.
  if (
    value.from &&
    typeof value.from.id === "string" &&
    value.from.id === pageId
  ) {
    return { status: "skipped", reason: "ECHO_FROM_PAGE" };
  }

  const conn = await findConnectionForAccount({
    channel: "FACEBOOK",
    externalAccountId: pageId,
  });
  if (!conn) {
    return { status: "skipped", reason: "UNKNOWN_ACCOUNT" };
  }

  return ingestComment({
    clientId: conn.clientId,
    provider: "FACEBOOK",
    externalAccountId: pageId,
    commentId: value.comment_id,
    parentPostId: value.post_id ?? value.parent_id ?? null,
    parentCommentId: value.parent_id && value.parent_id !== value.post_id ? value.parent_id : null,
    body: value.message ?? "",
    fromId: value.from?.id ?? null,
    fromName: value.from?.name ?? null,
    permalink: value.permalink_url ?? null,
    createdAtRaw: value.created_time ?? null,
    rawValue: value,
  });
}

// ── Instagram comment ──────────────────────────────────────────────────
//
// IG comment payloads are simpler than FB's: changes[].field =
// "comments", value.id = comment id, value.text = body, value.media.id
// is the post the comment lives on.
async function ingestInstagramComment({ igAccountId, value }) {
  if (!igAccountId || !value || typeof value !== "object") {
    return { status: "skipped", reason: "BAD_IG_CHANGE" };
  }
  // Echo guard — our own outbound IG comments come back through
  // the webhook with from.id = the IG user id (the workspace's
  // own account).
  if (
    value.from &&
    typeof value.from.id === "string" &&
    value.from.id === igAccountId
  ) {
    return { status: "skipped", reason: "ECHO_FROM_ACCOUNT" };
  }

  const conn = await findConnectionForAccount({
    channel: "INSTAGRAM",
    externalAccountId: igAccountId,
  });
  if (!conn) {
    return { status: "skipped", reason: "UNKNOWN_ACCOUNT" };
  }

  return ingestComment({
    clientId: conn.clientId,
    provider: "INSTAGRAM",
    externalAccountId: igAccountId,
    commentId: value.id,
    parentPostId: value.media?.id ?? null,
    parentCommentId: value.parent_id ?? null,
    body: value.text ?? "",
    fromId: value.from?.id ?? null,
    fromName: value.from?.username ?? value.from?.name ?? null,
    permalink: value.media?.permalink ?? null,
    createdAtRaw: value.created_time ?? null,
    rawValue: value,
  });
}

// ── Shared comment ingestion ───────────────────────────────────────────

async function ingestComment({
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

  // Idempotency check — same comment arriving twice (Meta retries
  // on non-2xx) must not duplicate the Message row. We key by
  // (conversationId-agnostic) Message.externalMessageId because
  // the comment id is globally unique within a provider.
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

  // Conversation lookup. Per spinstr10 we model one Conversation
  // per (page-post or media-post), keyed by externalThreadId =
  // parentPostId. That keeps all comments on the same post in
  // one inbox thread regardless of which commenter wrote them
  // — easier for the workspace user to triage than one thread
  // per commenter.
  //
  // Falls back to one-thread-per-comment-author when there's no
  // post id (rare, but Meta has edge cases — orphaned reply
  // notifications, etc).
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

  // Skip writing on spam-marked threads, but still report ok so
  // Meta stops retrying.
  if (conversation.spam) {
    return { status: "skipped", reason: "CONVERSATION_SPAM" };
  }

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      party: "CONTACT",
      channel: "SOCIAL_DM", // closest existing MessageChannel; comment-specific channel can come later
      body: typeof body === "string" ? body.slice(0, 4000) : "",
      payloadJson: sanitizeRawComment(rawValue),
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

// ── Helpers ────────────────────────────────────────────────────────────

async function findConnectionForAccount({ channel, externalAccountId }) {
  if (!externalAccountId) return null;
  return prisma.channelConnection.findFirst({
    where: {
      channel,
      externalAccountId,
      status: "CONNECTED",
    },
    select: { id: true, clientId: true, channel: true, scopes: true },
  });
}

// Look up a Contact by the Meta user id stored in
// enrichmentJson.externalIds.<PROVIDER>. If no match, create a new
// Contact with email/phone null — social commenters don't have
// either. clientId scoping enforced.
async function findOrCreateMetaContact({
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

// Whitelist what we keep from the raw webhook value. NO full
// payload echoes — the schema's payloadJson can hold any JSON
// but we limit what lands there so future migrations don't have
// to reckon with arbitrary Meta payload shape changes.
function sanitizeRawComment(value) {
  if (!value || typeof value !== "object") return null;
  const safe = {};
  if (typeof value.comment_id === "string") safe.comment_id = value.comment_id;
  if (typeof value.id === "string") safe.id = value.id;
  if (typeof value.post_id === "string") safe.post_id = value.post_id;
  if (typeof value.parent_id === "string") safe.parent_id = value.parent_id;
  if (typeof value.created_time === "string" || typeof value.created_time === "number")
    safe.created_time = value.created_time;
  if (typeof value.permalink_url === "string") safe.permalink_url = value.permalink_url;
  if (value.media && typeof value.media === "object") {
    safe.media = {
      id: typeof value.media.id === "string" ? value.media.id : null,
      permalink: typeof value.media.permalink === "string" ? value.media.permalink : null,
    };
  }
  if (value.from && typeof value.from === "object") {
    safe.from = {
      id: typeof value.from.id === "string" ? value.from.id : null,
      // Username for IG, name for FB — both are public display labels.
      username: typeof value.from.username === "string" ? value.from.username : undefined,
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
