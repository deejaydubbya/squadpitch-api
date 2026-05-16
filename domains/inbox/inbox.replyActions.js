// Channel-aware reply action resolver.
//
// Given a Conversation (with its Contact + Provider) and the
// workspace's current provider configuration, return an ordered
// list of action descriptors the composer can render. Email is the
// only fully-wired send channel today; everything else returns
// `available: false` with a recognizable reason so the UI can show
// "Connect <provider>" rather than a misleading send button.
//
// Shape pinned by the spinstr07 prompt:
//   SEND_EMAIL             — contact.email + email provider configured
//   SEND_SMS               — contact.phone + SMS provider configured
//   REPLY_PUBLIC_COMMENT   — provider supports comment replies AND
//                            the conversation has an externalMessageId
//   REPLY_DM               — provider supports DM AND externalThreadId
//   REPLY_REVIEW           — provider supports review replies
//   LOG_EXTERNAL_REPLY     — always available
//   INTERNAL_NOTE          — always available
//
// Each entry carries an `available` boolean + (when not) a
// `reason` string the UI surfaces verbatim.

import { env } from "../../config/env.js";
import { emailCapabilityFor } from "./inbox.outbound.email.service.js";
import { capabilityFor as providerMatrixFor } from "./providerCapabilities.js";

// Per-provider capability map. Drives which actions are
// theoretically possible for a given Conversation.provider — does
// NOT decide whether we can actually fire the send today (that's
// the second pass below, gated on env config + contact channels).
const PROVIDER_CAPABILITIES = {
  SQUADSITES:    { supportsEmail: true,  supportsSms: true,  supportsComment: false, supportsDm: false, supportsReview: false },
  EMAIL:         { supportsEmail: true,  supportsSms: false, supportsComment: false, supportsDm: false, supportsReview: false },
  SMS:           { supportsEmail: false, supportsSms: true,  supportsComment: false, supportsDm: false, supportsReview: false },
  FACEBOOK:      { supportsEmail: false, supportsSms: false, supportsComment: true,  supportsDm: true,  supportsReview: true  },
  INSTAGRAM:     { supportsEmail: false, supportsSms: false, supportsComment: true,  supportsDm: true,  supportsReview: false },
  GOOGLE_BUSINESS:{ supportsEmail: false, supportsSms: false, supportsComment: false, supportsDm: false, supportsReview: true  },
  YOUTUBE:       { supportsEmail: false, supportsSms: false, supportsComment: true,  supportsDm: false, supportsReview: false },
  LINKEDIN:      { supportsEmail: false, supportsSms: false, supportsComment: true,  supportsDm: true,  supportsReview: false },
  X:             { supportsEmail: false, supportsSms: false, supportsComment: true,  supportsDm: true,  supportsReview: false },
  TIKTOK:        { supportsEmail: false, supportsSms: false, supportsComment: true,  supportsDm: true,  supportsReview: false },
  THREADS:       { supportsEmail: false, supportsSms: false, supportsComment: true,  supportsDm: false, supportsReview: false },
  PINTEREST:     { supportsEmail: false, supportsSms: false, supportsComment: true,  supportsDm: false, supportsReview: false },
  WEB_CHAT:      { supportsEmail: true,  supportsSms: false, supportsComment: false, supportsDm: true,  supportsReview: false },
  MANUAL:        { supportsEmail: true,  supportsSms: true,  supportsComment: false, supportsDm: false, supportsReview: false },
};

function capabilitiesFor(provider) {
  return PROVIDER_CAPABILITIES[provider] ?? PROVIDER_CAPABILITIES.MANUAL;
}

// SMS provider config — mirrors isEmailProviderConfigured() in
// inbox.outbound.email.service.js but for Twilio. No send code
// path uses this yet; the resolver still wants to be honest about
// whether sending is *possible* so the UI can offer Connect copy.
function isSmsProviderConfigured() {
  return Boolean(
    env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.TWILIO_FROM_NUMBER,
  );
}

// Look up the most recent inbound message on the conversation —
// some action availabilities key off whether THAT message has an
// externalMessageId/externalThreadId (a public-comment reply needs
// the comment id; a DM reply needs the thread id).
function pickLastInbound(conversation) {
  if (!Array.isArray(conversation?.messages)) return null;
  for (const m of conversation.messages) {
    if (m.party === "CONTACT") return m;
  }
  return null;
}

/**
 * Resolve the ordered list of reply actions for a Conversation.
 *
 * @param {object} conversation — must include contact + (optionally) messages.
 * @param {object} [extras]    — pre-loaded per-conversation state the
 *                                resolver can't fetch itself (it's sync):
 *                                { gbpConnection? } — the workspace's
 *                                GOOGLE_BUSINESS_PROFILE ChannelConnection
 *                                row, when known. Used to flip REPLY_REVIEW
 *                                from "Connect..." to available.
 * @returns {Array<{action: string, label: string, available: boolean, reason: string|null, requiresConfig: boolean}>}
 */
export function getAvailableReplyActions(conversation, extras = {}) {
  if (!conversation) return [];
  const provider = conversation.provider ?? "SQUADSITES";
  const caps = capabilitiesFor(provider);
  const contact = conversation.contact ?? {};
  const lastInbound = pickLastInbound(conversation);

  const actions = [];

  // ── SEND_EMAIL ──────────────────────────────────────────────────────
  if (caps.supportsEmail) {
    // Re-use the existing email-capability check so the resolver
    // can't disagree with the actual outbound service.
    const cap = emailCapabilityFor({ conversation, contact });
    actions.push({
      action: "SEND_EMAIL",
      label: "Send email",
      available: cap.available,
      reason: cap.available ? null : cap.reason,
      // Distinguishes a missing channel (contact has no email) from
      // a missing config (workspace hasn't wired Postmark). The UI
      // uses this to choose "Add an email address" vs "Connect email".
      requiresConfig:
        !cap.available && (cap.reason ?? "").toLowerCase().includes("configured"),
    });
  }

  // ── SEND_SMS ────────────────────────────────────────────────────────
  if (caps.supportsSms) {
    const smsConfigured = isSmsProviderConfigured();
    const hasPhone = Boolean(contact.phone);
    const blocker = !smsConfigured
      ? "SMS sending is not configured for this workspace yet."
      : !hasPhone
        ? "This lead has no phone number on file."
        : conversation.spam
          ? "Conversation is marked as spam — unmark before sending."
          : null;
    actions.push({
      action: "SEND_SMS",
      label: "Send SMS",
      available: blocker === null,
      reason: blocker,
      requiresConfig: !smsConfigured,
    });
  }

  // Provider-matrix lookup — tells us WHY a reply path isn't
  // connected (missing OAuth scope, no adapter yet, etc.) so the
  // resolver can surface the truth rather than a generic
  // "isn't connected yet" message.
  const matrix = providerMatrixFor(provider);
  const scopeBlocker =
    matrix.missingScopes.length > 0
      ? `Pending Meta App Review for additional scopes (${matrix.missingScopes.join(", ")}).`
      : null;

  // ── REPLY_PUBLIC_COMMENT ────────────────────────────────────────────
  if (caps.supportsComment) {
    const hasCommentId = Boolean(
      lastInbound?.externalMessageId || lastInbound?.sourceUrl,
    );
    let reason;
    if (!hasCommentId) {
      reason = "No public comment to reply to on this conversation.";
    } else if (scopeBlocker) {
      reason = scopeBlocker;
    } else {
      reason = `Public comment reply isn't connected yet for ${humanizeProvider(provider)}.`;
    }
    actions.push({
      action: "REPLY_PUBLIC_COMMENT",
      label: "Reply to comment",
      available: false, // No send path wired for any provider yet.
      reason,
      requiresConfig: hasCommentId,
    });
  }

  // ── REPLY_DM ────────────────────────────────────────────────────────
  if (caps.supportsDm) {
    const hasThread = Boolean(conversation.externalThreadId);
    let reason;
    if (!hasThread) {
      reason = `No ${humanizeProvider(provider)} thread on this conversation.`;
    } else if (scopeBlocker) {
      reason = scopeBlocker;
    } else {
      reason = `${humanizeProvider(provider)} DM sending isn't connected yet.`;
    }
    actions.push({
      action: "REPLY_DM",
      label: "Reply via DM",
      available: false,
      reason,
      requiresConfig: hasThread,
    });
  }

  // ── REPLY_REVIEW ────────────────────────────────────────────────────
  if (caps.supportsReview) {
    // GBP case — when the workspace has a fully-configured
    // GOOGLE_BUSINESS_PROFILE connection (location picked +
    // business.manage in scopes), the action becomes available.
    if (provider === "GOOGLE_BUSINESS") {
      const gbp = extras?.gbpConnection ?? null;
      let available = false;
      let reason = "Connect a Google Business Profile location to reply to reviews.";
      let requiresConfig = true;
      if (gbp && gbp.status === "CONNECTED") {
        const hasLocation = typeof gbp.externalAccountId === "string" &&
          gbp.externalAccountId.includes("/locations/");
        const hasScope = Array.isArray(gbp.scopes) &&
          gbp.scopes.includes("https://www.googleapis.com/auth/business.manage");
        if (!hasLocation) {
          available = false;
          reason = "Pick a Google Business Profile location to reply to reviews.";
          requiresConfig = true;
        } else if (!hasScope) {
          available = false;
          reason = "Google Business Profile is connected, but review reply permission is not available.";
          requiresConfig = true;
        } else {
          available = true;
          reason = null;
          requiresConfig = false;
        }
      }
      actions.push({
        action: "REPLY_REVIEW",
        label: "Reply to review",
        available,
        reason,
        requiresConfig,
      });
    } else {
      actions.push({
        action: "REPLY_REVIEW",
        label: "Reply to review",
        available: false,
        reason:
          scopeBlocker ?? `${humanizeProvider(provider)} review replies aren't connected yet.`,
        requiresConfig: true,
      });
    }
  }

  // ── LOG_EXTERNAL_REPLY ──────────────────────────────────────────────
  // Always offered — records that the workspace user replied
  // outside Squadpitch (in another tool) without sending anything.
  actions.push({
    action: "LOG_EXTERNAL_REPLY",
    label: "Log external reply",
    available: true,
    reason: null,
    requiresConfig: false,
  });

  // ── INTERNAL_NOTE ───────────────────────────────────────────────────
  // Also always offered — workspace-private team note.
  actions.push({
    action: "INTERNAL_NOTE",
    label: "Internal note",
    available: true,
    reason: null,
    requiresConfig: false,
  });

  return actions;
}

function humanizeProvider(p) {
  if (!p) return "this channel";
  return p
    .toLowerCase()
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}
