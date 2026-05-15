// Declarative provider capability matrix.
//
// Source of truth for what each connected provider can *theoretically*
// do: ingest comments, ingest DMs/messages, ingest reviews, send a
// public reply, send a DM, plus the transport (webhook vs polling).
//
// This is NOT the run-time send gate. The send gate lives in
// inbox.replyActions.js → getAvailableReplyActions(), which checks
// per-conversation state (provider-thread ids, contact channels)
// AND per-workspace config (env, OAuth scopes, connection rows).
//
// Rather, this matrix is the design contract that:
//   1. Catalogs what's POSSIBLE per provider (API-wise),
//   2. Tracks the OAuth scopes Squadpitch currently requests,
//   3. Flags what additional scopes / app-review approvals are
//      needed before a future adapter can flip to send-capable.
//
// Update this file when scope sets change in domains/studio/oauth/*.
// Reply-action resolver tests pin the shape so accidental drift
// requires deliberate test updates.

/**
 * Each entry:
 *   ingestComments  / ingestDMs / ingestReviews  — what arrives in Inbox
 *   sendPublicReply / sendDM / sendReview        — outbound write capability
 *   webhooks                                     — provider pushes events
 *   polling                                      — we must pull
 *   currentScopes                                — what we request today
 *   missingScopes                                — what's needed for inbox features
 *   appReviewStatus                              — "live" | "submitted" | "not-submitted"
 *   notes                                        — gotchas / docs pointers
 */
export const providerCapabilities = {
  SQUADSITES: {
    label: "SquadSites form",
    ingestComments: false,
    ingestDMs: true,         // form submissions land as CONTACT messages
    ingestReviews: false,
    sendPublicReply: false,
    sendDM: false,           // direct outbound is email, handled separately
    sendReview: false,
    webhooks: false,         // internal — same-process intake
    polling: false,
    currentScopes: [],
    missingScopes: [],
    appReviewStatus: "live",
    notes:
      "Same-process intake from FormSubmission. Outbound replies go via the EMAIL adapter on the lead's contact.email.",
  },

  EMAIL: {
    label: "Email (Postmark)",
    ingestComments: false,
    ingestDMs: true,         // inbound replies via Postmark webhook
    ingestReviews: false,
    sendPublicReply: false,
    sendDM: true,            // outbound via Postmark sendEmail — PROVEN
    sendReview: false,
    webhooks: true,          // Postmark inbound webhook
    polling: false,
    currentScopes: ["POSTMARK_SERVER_TOKEN", "POSTMARK_INBOUND_WEBHOOK_SECRET"],
    missingScopes: [],
    appReviewStatus: "live",
    notes:
      "Only proven send channel. RFC threading + idempotency + reopen-on-inbound all in place. Postmark account out of sandbox at INBOX_EMAIL_FROM swap.",
  },

  SMS: {
    label: "SMS (Twilio)",
    ingestComments: false,
    ingestDMs: true,         // possible: Twilio inbound SMS webhook
    ingestReviews: false,
    sendPublicReply: false,
    sendDM: true,            // possible: Twilio Programmable Messaging
    sendReview: false,
    webhooks: true,
    polling: false,
    currentScopes: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    missingScopes: [],
    appReviewStatus: "not-submitted",
    notes:
      "Env vars exist but no adapter yet. Need outbound service mirroring inbox.outbound.email.service.js + inbound webhook route. A2P 10DLC registration required for US carriers before any production send.",
  },

  FACEBOOK: {
    label: "Facebook Page",
    ingestComments: false,   // would need pages_read_user_content + webhook subscription
    ingestDMs: false,        // pages_messaging gated
    ingestReviews: false,    // Recommendations API limited
    sendPublicReply: false,  // pages_manage_engagement gated
    sendDM: false,           // pages_messaging gated
    sendReview: false,
    webhooks: true,          // Meta Webhooks (Page subscriptions)
    polling: true,           // fallback
    currentScopes: [
      "pages_manage_posts",
      "pages_read_engagement",
      "pages_show_list",
      "read_insights",
    ],
    missingScopes: [
      "pages_read_user_content",     // comments + reactions read
      "pages_manage_engagement",     // hide/reply to comments
      "pages_messaging",             // DM read + send (24h response window)
      "pages_messaging_subscriptions", // DM webhooks
    ],
    appReviewStatus: "submitted",    // pages_read_engagement + read_insights in flight
    notes:
      "Publishing works. Comments/DMs require Meta App Review for additional scopes. Use Meta Page Webhooks once granted. See docs/inbox-provider-capabilities.md.",
  },

  INSTAGRAM: {
    label: "Instagram (Business)",
    ingestComments: false,   // needs instagram_manage_comments
    ingestDMs: false,        // needs instagram_manage_messages
    ingestReviews: false,
    sendPublicReply: false,
    sendDM: false,
    sendReview: false,
    webhooks: true,          // via Meta — same webhook system
    polling: true,
    currentScopes: [
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_insights",
      "pages_show_list",
      "pages_read_engagement",
      "business_management",
    ],
    missingScopes: [
      "instagram_manage_comments",
      "instagram_manage_messages",
    ],
    appReviewStatus: "submitted",    // basic + insights in flight
    notes:
      "Publishing + insights work. Inbox needs two more scopes + Meta Webhooks subscriptions for Comments and Messages.",
  },

  GOOGLE_BUSINESS: {
    label: "Google Business Profile",
    ingestComments: false,
    ingestDMs: false,        // GBP Messages API was deprecated 2024
    ingestReviews: false,    // possible via Reviews API
    sendPublicReply: false,
    sendDM: false,
    sendReview: false,       // possible: reviews.reply
    webhooks: false,         // no push API for reviews — polling only
    polling: true,
    currentScopes: [],
    missingScopes: ["https://www.googleapis.com/auth/business.manage"],
    appReviewStatus: "not-submitted",
    notes:
      "No integration today — needs full OAuth + adapter. Reviews polling on a fixed interval. business.manage is a sensitive scope (Google verification required). Messages API deprecated; only reviews are workable.",
  },

  YOUTUBE: {
    label: "YouTube",
    ingestComments: true,    // youtube.readonly already grants commentThreads.list
    ingestDMs: false,        // no DM API on YouTube
    ingestReviews: false,
    sendPublicReply: false,  // needs youtube.force-ssl
    sendDM: false,
    sendReview: false,
    webhooks: false,         // PubSubHubbub only for new videos, not comments
    polling: true,
    currentScopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
    missingScopes: [
      "https://www.googleapis.com/auth/youtube.force-ssl", // comment reply
    ],
    appReviewStatus: "live",         // current scopes already approved
    notes:
      "Comment-read is technically possible today via readonly + commentThreads polling. Reply needs youtube.force-ssl and Google sensitive-scope verification. No webhook for comments — polling required.",
  },

  LINKEDIN: {
    label: "LinkedIn (personal)",
    ingestComments: false,   // personal posts have no programmatic comment ingest
    ingestDMs: false,        // LinkedIn Messaging API is closed
    ingestReviews: false,
    sendPublicReply: false,
    sendDM: false,
    sendReview: false,
    webhooks: false,
    polling: false,
    currentScopes: ["openid", "profile", "w_member_social"],
    missingScopes: ["r_member_social"],  // even with this, comment-read on personal posts isn't reliable
    appReviewStatus: "live",
    notes:
      "Personal-feed Inbox isn't viable on LinkedIn's current partner API. Defer entirely — orgs are the realistic surface.",
  },

  LINKEDIN_ORG: {
    label: "LinkedIn (organization)",
    ingestComments: true,    // r_organization_social grants socialActions.list
    ingestDMs: false,
    ingestReviews: false,
    sendPublicReply: true,   // w_organization_social — can comment as org
    sendDM: false,
    sendReview: false,
    webhooks: false,         // LinkedIn does NOT push org events
    polling: true,
    currentScopes: [
      "r_organization_admin",
      "w_organization_social",
      "r_organization_social",
    ],
    missingScopes: [],       // scopes are already sufficient for org comments
    appReviewStatus: "live",
    notes:
      "Org comments are theoretically wireable today — scopes are right. Polling required (no webhooks). Need adapter + LinkedIn rate-limit handling.",
  },

  X: {
    label: "X (Twitter)",
    ingestComments: false,   // would need tier-gated mentions endpoint at scale
    ingestDMs: false,        // dm.read scope NOT in our set + tier-gated
    ingestReviews: false,
    sendPublicReply: true,   // tweet.write is in scope — could reply
    sendDM: false,           // dm.write not in scope
    sendReview: false,
    webhooks: false,         // Account Activity API requires Enterprise tier
    polling: true,
    currentScopes: ["tweet.write", "tweet.read", "users.read", "offline.access"],
    missingScopes: ["dm.read", "dm.write"],
    appReviewStatus: "live",
    notes:
      "Free tier strictly rate-limited (50 read/24h). Webhooks gated to Pro/Enterprise. Defer until usage justifies a paid X tier.",
  },

  TIKTOK: {
    label: "TikTok",
    ingestComments: false,
    ingestDMs: false,
    ingestReviews: false,
    sendPublicReply: false,
    sendDM: false,
    sendReview: false,
    webhooks: false,
    polling: false,
    currentScopes: ["user.info.basic", "video.publish"],
    missingScopes: [],       // TikTok has no public comment/DM APIs
    appReviewStatus: "live",
    notes:
      "Publish-only. TikTok does not expose comment or DM APIs to third parties. Inbox cannot ingest from TikTok today.",
  },

  THREADS: {
    label: "Threads",
    ingestComments: false,   // possible: threads_read_replies + webhook
    ingestDMs: false,        // Threads has no DM API
    ingestReviews: false,
    sendPublicReply: false,  // possible: threads_manage_replies
    sendDM: false,
    sendReview: false,
    webhooks: true,          // Threads Webhook supports replies
    polling: true,
    currentScopes: [
      "threads_basic",
      "threads_content_publish",
      "threads_manage_insights",
      "threads_manage_replies",
      "threads_read_replies",
    ],
    missingScopes: [],       // scopes are right; webhook subscription + adapter remain
    appReviewStatus: "live", // already in production for publishing
    notes:
      "Reply scopes already in place. Subscribe webhook for THREADS_REPLIES event + add ingestion adapter + reply send. Likely the cheapest social Inbox channel to wire next after GBP reviews.",
  },

  PINTEREST: {
    label: "Pinterest",
    ingestComments: false,   // would need pin_comment scopes (none requested)
    ingestDMs: false,        // no DM API
    ingestReviews: false,
    sendPublicReply: false,
    sendDM: false,
    sendReview: false,
    webhooks: false,
    polling: false,
    currentScopes: [
      "user_accounts:read",
      "boards:read",
      "boards:write",
      "pins:read",
      "pins:write",
    ],
    missingScopes: ["pin_comment:read", "pin_comment:write"],
    appReviewStatus: "live", // Standard access granted for current scopes
    notes:
      "Publish-only today. Pin comments are a small fraction of Pinterest engagement; defer indefinitely.",
  },

  WEB_CHAT: {
    label: "Web chat",
    ingestComments: false,
    ingestDMs: true,
    ingestReviews: false,
    sendPublicReply: false,
    sendDM: true,
    sendReview: false,
    webhooks: true,         // same-process via website widget
    polling: false,
    currentScopes: [],
    missingScopes: [],
    appReviewStatus: "not-submitted",
    notes:
      "Future website chat widget. No code yet. Would mirror SquadSites form intake.",
  },

  MANUAL: {
    label: "Manual",
    ingestComments: false,
    ingestDMs: true,         // user records the message themselves
    ingestReviews: false,
    sendPublicReply: false,
    sendDM: false,
    sendReview: false,
    webhooks: false,
    polling: false,
    currentScopes: [],
    missingScopes: [],
    appReviewStatus: "live",
    notes:
      "Logged-only — workspace user pastes what was said outside Squadpitch. No outbound send.",
  },
};

/**
 * Get the capability descriptor for a Conversation.provider value.
 * Falls back to MANUAL for unknown providers (matches the runtime
 * resolver's fallback in inbox.replyActions.js).
 */
export function capabilityFor(provider) {
  return providerCapabilities[provider] ?? providerCapabilities.MANUAL;
}

/**
 * Recommended implementation order for Inbox channel adapters.
 * Matches the spinstr08 prompt's suggested ordering, refined for
 * what's actually feasible given current scopes + provider state.
 */
export const RECOMMENDED_ORDER = [
  // 0. Already shipped — proven adapter.
  "EMAIL",
  // 1. Reviews-only surface; high value, no DM complexity. Sensitive
  //    scope but Google verification is straightforward.
  "GOOGLE_BUSINESS",
  // 2. Same Meta webhook plumbing as Instagram; add the scopes to
  //    the in-flight Meta App Review submission.
  "FACEBOOK",
  // 3. Mirrors FACEBOOK once the Meta App Review submission lands.
  "INSTAGRAM",
  // 4. FB + IG DMs — Meta-gated, harder review (24h window rules).
  //    Wait until comment ingestion is operating cleanly.
  "FACEBOOK_DMS",
  "INSTAGRAM_DMS",
  // 5. YouTube comments — polling-only; needs youtube.force-ssl for
  //    reply (Google sensitive-scope verification).
  "YOUTUBE",
  // 6. LinkedIn org comments — scopes are already correct; polling
  //    + rate-limit handling left to do.
  "LINKEDIN_ORG",
  // 7. SMS — Twilio + A2P 10DLC paperwork; useful but not a social
  //    surface, so ranked after the social ones with active demand.
  "SMS",
  // 8. Threads reply ingestion — scopes ready, low-volume channel.
  "THREADS",
  // 9–12. Defer until usage justifies the effort.
  "X",
  "TIKTOK",
  "PINTEREST",
  "LINKEDIN", // personal — likely never viable
];
