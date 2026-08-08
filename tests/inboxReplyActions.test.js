// Channel-aware reply action resolver.
//
// Pins the contract from spinstr07:
//   - SquadSites with email contact + Postmark configured →
//     SEND_EMAIL is available
//   - SquadSites with no email contact → SEND_EMAIL unavailable
//     with a contact-channel reason (not a config reason)
//   - SquadSites with no Postmark env → SEND_EMAIL unavailable
//     with requiresConfig=true
//   - Facebook conversation → surfaces REPLY_PUBLIC_COMMENT +
//     REPLY_DM + REPLY_REVIEW as not-available (no send paths
//     wired yet)
//   - Every conversation always offers LOG_EXTERNAL_REPLY and
//     INTERNAL_NOTE
//   - Spam conversation suppresses SEND_EMAIL via the same
//     blocker the outbound service uses
//
// We mock the env module so SMS-config and Postmark-config flips
// can be tested without booting any provider.

import { describe, it, expect, vi, beforeEach } from "vitest";

let envOverrides;
vi.mock("../config/env.js", () => ({
  get env() {
    return envOverrides;
  },
}));

const { getAvailableReplyActions } =
  await import("../domains/inbox/inbox.replyActions.js");

function findAction(actions, id) {
  return actions.find((a) => a.action === id) ?? null;
}

function makeConversation({
  provider = "SQUADSITES",
  email = "lead@example.com",
  phone = "+15551234567",
  spam = false,
  externalThreadId = null,
  messages = [],
} = {}) {
  return {
    id: "conv-1",
    clientId: "client-1",
    provider,
    spam,
    externalThreadId,
    contact: {
      id: "contact-1",
      email,
      phone,
      name: "Lead",
      status: "NEW",
    },
    messages,
  };
}

beforeEach(() => {
  envOverrides = {
    POSTMARK_SERVER_TOKEN: "test-token",
    INBOX_EMAIL_FROM: "Squadpitch Inbox <inbox@mail.squadpitch.com>",
    INBOX_EMAIL_REPLY_DOMAIN: "mail.squadpitch.com",
    POSTMARK_MESSAGE_STREAM: "outbound",
    POSTMARK_INBOUND_WEBHOOK_SECRET: "test-secret",
    POSTMARK_ACCOUNT_APPROVED: true,
    POSTMARK_SENDER_VERIFIED: true,
    POSTMARK_DELIVERY_VERIFIED: true,
    TWILIO_ACCOUNT_SID: null,
    TWILIO_AUTH_TOKEN: null,
    TWILIO_FROM_NUMBER: null,
  };
});

// ── SquadSites baseline ────────────────────────────────────────────────

describe("getAvailableReplyActions — SquadSites (form intake)", () => {
  it("offers SEND_EMAIL when email + Postmark are configured", () => {
    const actions = getAvailableReplyActions(makeConversation());
    const send = findAction(actions, "SEND_EMAIL");
    expect(send).toBeTruthy();
    expect(send.available).toBe(true);
    expect(send.capability.channelEligible).toBe(true);
    expect(send.capability.recipientAvailable).toBe(true);
    expect(send.capability.canSend).toBe(true);
    expect(send.reason).toBeNull();
    expect(send.requiresConfig).toBe(false);
  });

  it("blocks SEND_EMAIL when the lead has no email (contact-level, not config)", () => {
    const actions = getAvailableReplyActions(makeConversation({ email: null }));
    const send = findAction(actions, "SEND_EMAIL");
    expect(send.available).toBe(false);
    expect(send.capability.channelEligible).toBe(true);
    expect(send.capability.recipientAvailable).toBe(false);
    expect(send.capability.blockedCode).toBe("EMAIL_RECIPIENT_MISSING");
    expect(send.reason).toMatch(/add an email address/i);
    expect(send.requiresConfig).toBe(false);
  });

  it("blocks SEND_EMAIL with requiresConfig when Postmark isn't configured", () => {
    envOverrides.POSTMARK_SERVER_TOKEN = null;
    envOverrides.INBOX_EMAIL_FROM = null;
    const actions = getAvailableReplyActions(makeConversation());
    const send = findAction(actions, "SEND_EMAIL");
    expect(send.available).toBe(false);
    expect(send.reason).toMatch(/not configured/i);
    expect(send.requiresConfig).toBe(true);
  });

  it("blocks SEND_EMAIL when the conversation is spam", () => {
    const actions = getAvailableReplyActions(makeConversation({ spam: true }));
    const send = findAction(actions, "SEND_EMAIL");
    expect(send.available).toBe(false);
    expect(send.reason).toMatch(/spam/i);
  });

  it("keeps SEND_EMAIL disabled until outbound delivery and reply are verified", () => {
    envOverrides.POSTMARK_DELIVERY_VERIFIED = false;
    const send = findAction(
      getAvailableReplyActions(makeConversation()),
      "SEND_EMAIL",
    );
    expect(send.available).toBe(false);
    expect(send.capability.blockedCode).toBe("EMAIL_DELIVERY_UNVERIFIED");
    expect(send.reason).toMatch(/outbound and reply verification/i);
    expect(send.requiresConfig).toBe(false);
  });

  it("offers SEND_SMS as a placeholder with requiresConfig when Twilio isn't wired", () => {
    const actions = getAvailableReplyActions(makeConversation());
    const sms = findAction(actions, "SEND_SMS");
    expect(sms).toBeTruthy();
    expect(sms.available).toBe(false);
    expect(sms.requiresConfig).toBe(true);
    expect(sms.reason).toMatch(/temporarily unavailable/i);
  });

  it("offers SEND_SMS as available-blocked when Twilio is wired but contact has no phone", () => {
    envOverrides.TWILIO_ACCOUNT_SID = "AC123";
    envOverrides.TWILIO_AUTH_TOKEN = "auth";
    envOverrides.TWILIO_FROM_NUMBER = "+15550000000";
    // spinstr13 — also need the A2P + sending flags on so the gate
    // doesn't pre-empt the no-phone check. Resolver surfaces the
    // most blocking reason in order: configured → A2P → enabled →
    // phone → opt-out → spam.
    envOverrides.SMS_A2P_APPROVED = true;
    envOverrides.SMS_SENDING_ENABLED = true;
    const actions = getAvailableReplyActions(makeConversation({ phone: null }));
    const sms = findAction(actions, "SEND_SMS");
    expect(sms.available).toBe(false);
    expect(sms.requiresConfig).toBe(false);
    expect(sms.reason).toMatch(/temporarily unavailable/i);
  });

  // spinstr13 — A2P gate. Twilio creds + phone in place, but the
  // A2P_APPROVED flag is false → resolver pins the truthful
  // approval-pending reason. UI surfaces this in the SMS tab's
  // disabled state.
  it("SEND_SMS pinned to 'Awaiting Twilio business profile / A2P 10DLC approval' when flag is off", () => {
    envOverrides.TWILIO_ACCOUNT_SID = "AC123";
    envOverrides.TWILIO_AUTH_TOKEN = "auth";
    envOverrides.TWILIO_FROM_NUMBER = "+15550000000";
    envOverrides.SMS_A2P_APPROVED = false;
    envOverrides.SMS_SENDING_ENABLED = true;
    const sms = findAction(
      getAvailableReplyActions(makeConversation()),
      "SEND_SMS",
    );
    expect(sms.available).toBe(false);
    expect(sms.reason).toMatch(/temporarily unavailable/i);
    expect(sms.requiresConfig).toBe(true);
  });

  it("SEND_SMS pinned to 'sending is not enabled' when A2P is approved but kill switch off", () => {
    envOverrides.TWILIO_ACCOUNT_SID = "AC123";
    envOverrides.TWILIO_AUTH_TOKEN = "auth";
    envOverrides.TWILIO_FROM_NUMBER = "+15550000000";
    envOverrides.SMS_A2P_APPROVED = true;
    envOverrides.SMS_SENDING_ENABLED = false;
    const sms = findAction(
      getAvailableReplyActions(makeConversation()),
      "SEND_SMS",
    );
    expect(sms.available).toBe(false);
    expect(sms.reason).toMatch(/temporarily unavailable/i);
  });

  it("SEND_SMS short-circuits when contact has opted out of SMS", () => {
    envOverrides.TWILIO_ACCOUNT_SID = "AC123";
    envOverrides.TWILIO_AUTH_TOKEN = "auth";
    envOverrides.TWILIO_FROM_NUMBER = "+15550000000";
    envOverrides.SMS_A2P_APPROVED = true;
    envOverrides.SMS_SENDING_ENABLED = true;
    const conv = makeConversation();
    conv.contact.enrichmentJson = { smsOptOut: true };
    const sms = findAction(getAvailableReplyActions(conv), "SEND_SMS");
    expect(sms.available).toBe(false);
    expect(sms.reason).toMatch(/temporarily unavailable/i);
  });

  it("keeps SEND_SMS unavailable even with stale enabled flags and credentials", () => {
    envOverrides.TWILIO_ACCOUNT_SID = "AC123";
    envOverrides.TWILIO_AUTH_TOKEN = "auth";
    envOverrides.TWILIO_FROM_NUMBER = "+15550000000";
    envOverrides.SMS_A2P_APPROVED = true;
    envOverrides.SMS_SENDING_ENABLED = true;
    const sms = findAction(
      getAvailableReplyActions(makeConversation()),
      "SEND_SMS",
    );
    expect(sms.available).toBe(false);
    expect(sms.reason).toMatch(/temporarily unavailable/i);
  });

  it("does NOT surface REPLY_PUBLIC_COMMENT / REPLY_DM / REPLY_REVIEW for SquadSites", () => {
    const actions = getAvailableReplyActions(makeConversation());
    expect(findAction(actions, "REPLY_PUBLIC_COMMENT")).toBeNull();
    expect(findAction(actions, "REPLY_DM")).toBeNull();
    expect(findAction(actions, "REPLY_REVIEW")).toBeNull();
  });
});

// ── Social provider ────────────────────────────────────────────────────

describe("getAvailableReplyActions — Facebook conversation", () => {
  it("REPLY_PUBLIC_COMMENT defaults to Connect-Facebook copy when no FB connection is loaded", () => {
    // Post-outbound-adapter (audit follow-up): the resolver now
    // gates on the actual connection + pages_manage_engagement.
    // No connection in extras → "Connect Facebook to reply" with
    // requiresConfig=true so the FE renders a Connect button.
    const conv = makeConversation({
      provider: "FACEBOOK",
      email: null,
      phone: null,
      externalThreadId: "fb-thread-1",
      messages: [
        {
          id: "m-1",
          party: "CONTACT",
          externalMessageId: "fb-comment-1",
          sourceUrl: "https://facebook.com/post/123",
        },
      ],
    });
    const actions = getAvailableReplyActions(conv);

    const comment = findAction(actions, "REPLY_PUBLIC_COMMENT");
    expect(comment).toBeTruthy();
    expect(comment.available).toBe(false);
    expect(comment.requiresConfig).toBe(true);
    expect(comment.reason).toMatch(/Connect Facebook/i);

    const dm = findAction(actions, "REPLY_DM");
    expect(dm).toBeTruthy();
    expect(dm.available).toBe(false);
    expect(dm.requiresConfig).toBe(true);

    const review = findAction(actions, "REPLY_REVIEW");
    expect(review).toBeTruthy();
    expect(review.available).toBe(false);
    expect(review.requiresConfig).toBe(true);
  });

  it("REPLY_PUBLIC_COMMENT flips to available when FB connection grants pages_manage_engagement", () => {
    const conv = makeConversation({
      provider: "FACEBOOK",
      email: null,
      phone: null,
      messages: [
        { id: "m-1", party: "CONTACT", externalMessageId: "fb-comment-1" },
      ],
    });
    const actions = getAvailableReplyActions(conv, {
      facebookConnection: {
        id: "conn-fb-1",
        status: "CONNECTED",
        externalAccountId: "100000000000001",
        scopes: [
          "public_profile",
          "pages_show_list",
          "pages_read_engagement",
          "pages_manage_posts",
          "read_insights",
          "pages_read_user_content",
          "pages_manage_engagement",
        ],
      },
    });
    const comment = findAction(actions, "REPLY_PUBLIC_COMMENT");
    expect(comment.available).toBe(true);
    expect(comment.reason).toBeNull();
    expect(comment.requiresConfig).toBe(false);
  });

  it("REPLY_PUBLIC_COMMENT stays disabled with reconnect copy when pages_manage_engagement is NOT granted", () => {
    const conv = makeConversation({
      provider: "FACEBOOK",
      email: null,
      phone: null,
      messages: [
        { id: "m-1", party: "CONTACT", externalMessageId: "fb-comment-1" },
      ],
    });
    const actions = getAvailableReplyActions(conv, {
      facebookConnection: {
        id: "conn-fb-1",
        status: "CONNECTED",
        externalAccountId: "100000000000001",
        scopes: [
          "public_profile",
          "pages_show_list",
          "pages_read_engagement",
          "pages_manage_posts",
          "read_insights",
          // pages_manage_engagement intentionally missing
        ],
      },
    });
    const comment = findAction(actions, "REPLY_PUBLIC_COMMENT");
    expect(comment.available).toBe(false);
    expect(comment.requiresConfig).toBe(true);
    expect(comment.reason).toMatch(/pages_manage_engagement/);
    expect(comment.reason).toMatch(/Reconnect Facebook/i);
  });

  it("REPLY_PUBLIC_COMMENT explains there's nothing to reply to when no externalMessageId", () => {
    const conv = makeConversation({
      provider: "FACEBOOK",
      email: null,
      phone: null,
      externalThreadId: null,
      messages: [
        {
          id: "m-1",
          party: "CONTACT",
          externalMessageId: null,
          sourceUrl: null,
        },
      ],
    });
    const actions = getAvailableReplyActions(conv);
    const comment = findAction(actions, "REPLY_PUBLIC_COMMENT");
    expect(comment.reason).toMatch(/No public comment/i);
    expect(comment.requiresConfig).toBe(false);
  });

  it("REPLY_DM explains there's no thread when externalThreadId is null", () => {
    const conv = makeConversation({
      provider: "FACEBOOK",
      email: null,
      phone: null,
      externalThreadId: null,
    });
    const actions = getAvailableReplyActions(conv);
    const dm = findAction(actions, "REPLY_DM");
    expect(dm.reason).toMatch(/No Facebook thread/i);
    expect(dm.requiresConfig).toBe(false);
  });

  it("does NOT surface SEND_EMAIL or SEND_SMS for a Facebook conversation", () => {
    const conv = makeConversation({ provider: "FACEBOOK" });
    const actions = getAvailableReplyActions(conv);
    expect(findAction(actions, "SEND_EMAIL")).toBeNull();
    expect(findAction(actions, "SEND_SMS")).toBeNull();
  });
});

// ── Other providers ────────────────────────────────────────────────────

describe("getAvailableReplyActions — Google Business / Instagram / YouTube", () => {
  it("Google Business gets REPLY_REVIEW but not comment/DM", () => {
    const conv = makeConversation({
      provider: "GOOGLE_BUSINESS",
      email: null,
      phone: null,
    });
    const actions = getAvailableReplyActions(conv);
    expect(findAction(actions, "REPLY_REVIEW")).toBeTruthy();
    expect(findAction(actions, "REPLY_PUBLIC_COMMENT")).toBeNull();
    expect(findAction(actions, "REPLY_REVIEW").available).toBe(false);
    expect(findAction(actions, "REPLY_PUBLIC_COMMENT")).toBeNull();
  });

  it("Google Business REPLY_REVIEW flips to available when GBP connection has location + business.manage", () => {
    const conv = makeConversation({
      provider: "GOOGLE_BUSINESS",
      email: null,
      phone: null,
    });
    const actions = getAvailableReplyActions(conv, {
      gbpConnection: {
        status: "CONNECTED",
        externalAccountId: "accounts/100/locations/A1",
        scopes: ["https://www.googleapis.com/auth/business.manage"],
      },
    });
    const review = findAction(actions, "REPLY_REVIEW");
    expect(review.available).toBe(true);
    expect(review.reason).toBeNull();
  });

  it("Google Business REPLY_REVIEW stays disabled when location picker hasn't run", () => {
    const conv = makeConversation({
      provider: "GOOGLE_BUSINESS",
      email: null,
      phone: null,
    });
    const actions = getAvailableReplyActions(conv, {
      gbpConnection: {
        status: "CONNECTED",
        externalAccountId: "accounts/100", // sentinel — no /locations/
        scopes: ["https://www.googleapis.com/auth/business.manage"],
      },
    });
    const review = findAction(actions, "REPLY_REVIEW");
    expect(review.available).toBe(false);
    expect(review.reason).toMatch(/Pick a Google Business Profile location/i);
  });

  it("Google Business REPLY_REVIEW stays disabled when business.manage scope is missing", () => {
    const conv = makeConversation({
      provider: "GOOGLE_BUSINESS",
      email: null,
      phone: null,
    });
    const actions = getAvailableReplyActions(conv, {
      gbpConnection: {
        status: "CONNECTED",
        externalAccountId: "accounts/100/locations/A1",
        scopes: ["unrelated_scope"],
      },
    });
    const review = findAction(actions, "REPLY_REVIEW");
    expect(review.available).toBe(false);
    expect(review.reason).toMatch(/review reply permission is not available/i);
  });

  // spinstr414 — even when location + scope look fine, the
  // REVIEW_API_ACCESS_DENIED marker (set by the poller after
  // Google rejects reviews.list) must keep REPLY_REVIEW disabled.
  // Better to refuse pre-flight than mark available and have the
  // send fail at runtime.
  it("Google Business REPLY_REVIEW stays disabled when the access-denied marker is set", () => {
    const conv = makeConversation({
      provider: "GOOGLE_BUSINESS",
      email: null,
      phone: null,
    });
    const actions = getAvailableReplyActions(conv, {
      gbpConnection: {
        status: "CONNECTED",
        externalAccountId: "accounts/100/locations/A1",
        scopes: ["https://www.googleapis.com/auth/business.manage"],
        lastError:
          "REVIEW_API_ACCESS_DENIED: Google My Business API has not been used in project 822617393173",
      },
    });
    const review = findAction(actions, "REPLY_REVIEW");
    expect(review.available).toBe(false);
    // Copy aligned with spinstr415 — same phrasing across resolver
    // reason, Settings banner, and outbound reply pre-flight error.
    expect(review.reason).toMatch(
      /Awaiting Google Business Profile API access approval/i,
    );
    // No "Connect..." — the user can't fix this themselves; we're
    // waiting on Google.
    expect(review.requiresConfig).toBe(false);
  });

  // Successful account/location APIs (modern v1 surface) do not
  // imply that reviews.list is reachable — that lives on the
  // legacy mybusiness.googleapis.com which requires its own
  // allowlisting. The resolver MUST NOT infer review readiness
  // from connection-only state.
  it("a fully-configured GBP connection does not imply review readiness if marker is set", () => {
    const conv = makeConversation({
      provider: "GOOGLE_BUSINESS",
      email: null,
      phone: null,
    });
    const withMarker = getAvailableReplyActions(conv, {
      gbpConnection: {
        status: "CONNECTED",
        externalAccountId: "accounts/100/locations/A1",
        scopes: ["https://www.googleapis.com/auth/business.manage"],
        lastError: "REVIEW_API_ACCESS_DENIED: x",
      },
    });
    expect(findAction(withMarker, "REPLY_REVIEW").available).toBe(false);

    const withoutMarker = getAvailableReplyActions(conv, {
      gbpConnection: {
        status: "CONNECTED",
        externalAccountId: "accounts/100/locations/A1",
        scopes: ["https://www.googleapis.com/auth/business.manage"],
        lastError: null,
      },
    });
    expect(findAction(withoutMarker, "REPLY_REVIEW").available).toBe(true);
  });

  it("YouTube gets REPLY_PUBLIC_COMMENT but no DM or review", () => {
    const conv = makeConversation({
      provider: "YOUTUBE",
      email: null,
      phone: null,
    });
    const actions = getAvailableReplyActions(conv);
    expect(findAction(actions, "REPLY_PUBLIC_COMMENT")).toBeTruthy();
    expect(findAction(actions, "REPLY_DM")).toBeNull();
    expect(findAction(actions, "REPLY_REVIEW")).toBeNull();
  });

  // spinstr416 — YouTube comment reply path. Wireable today only
  // when the connection's stored scopes include youtube.force-ssl
  // (test users on the Google Cloud project can grant it; everyone
  // else hits Google's unverified-app guard until sensitive-scope
  // verification lands).
  it("YouTube REPLY_PUBLIC_COMMENT stays disabled when there's no externalMessageId on the inbound", () => {
    const conv = makeConversation({
      provider: "YOUTUBE",
      email: null,
      phone: null,
      messages: [
        { party: "CONTACT", externalMessageId: null, sourceUrl: null },
      ],
    });
    const action = findAction(
      getAvailableReplyActions(conv),
      "REPLY_PUBLIC_COMMENT",
    );
    expect(action.available).toBe(false);
    expect(action.reason).toMatch(/no public comment to reply to/i);
  });

  it("YouTube REPLY_PUBLIC_COMMENT asks to connect YouTube when no connection is loaded", () => {
    const conv = makeConversation({
      provider: "YOUTUBE",
      email: null,
      phone: null,
      messages: [
        { party: "CONTACT", externalMessageId: "Ugxyz", sourceUrl: null },
      ],
    });
    const action = findAction(
      getAvailableReplyActions(conv),
      "REPLY_PUBLIC_COMMENT",
    );
    expect(action.available).toBe(false);
    expect(action.reason).toMatch(/Connect YouTube/i);
  });

  it("YouTube REPLY_PUBLIC_COMMENT asks for the force-ssl reconnect when scope is missing", () => {
    const conv = makeConversation({
      provider: "YOUTUBE",
      email: null,
      phone: null,
      messages: [
        { party: "CONTACT", externalMessageId: "Ugxyz", sourceUrl: null },
      ],
    });
    const action = findAction(
      getAvailableReplyActions(conv, {
        youtubeConnection: {
          status: "CONNECTED",
          externalAccountId: "UCabc",
          scopes: [
            "https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/youtube.readonly",
          ],
        },
      }),
      "REPLY_PUBLIC_COMMENT",
    );
    expect(action.available).toBe(false);
    expect(action.reason).toMatch(/youtube\.force-ssl/);
  });

  it("YouTube REPLY_PUBLIC_COMMENT flips to available when force-ssl is in the granted scopes", () => {
    const conv = makeConversation({
      provider: "YOUTUBE",
      email: null,
      phone: null,
      messages: [
        { party: "CONTACT", externalMessageId: "Ugxyz", sourceUrl: null },
      ],
    });
    const action = findAction(
      getAvailableReplyActions(conv, {
        youtubeConnection: {
          status: "CONNECTED",
          externalAccountId: "UCabc",
          scopes: [
            "https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/youtube.readonly",
            "https://www.googleapis.com/auth/youtube.force-ssl",
          ],
        },
      }),
      "REPLY_PUBLIC_COMMENT",
    );
    expect(action.available).toBe(true);
    expect(action.reason).toBeNull();
  });

  // spinstr416 — LinkedIn org comment + DM are gated on
  // LinkedIn's Community Management API approval. Until that
  // lands, resolver must always surface the truthful pending-
  // approval reason regardless of connection state.
  it("LinkedIn REPLY_PUBLIC_COMMENT is pinned to the Community Management API pending reason", () => {
    const conv = makeConversation({
      provider: "LINKEDIN",
      email: null,
      phone: null,
      messages: [
        {
          party: "CONTACT",
          externalMessageId: "urn:li:comment:1",
          sourceUrl: null,
        },
      ],
    });
    const action = findAction(
      getAvailableReplyActions(conv),
      "REPLY_PUBLIC_COMMENT",
    );
    expect(action.available).toBe(false);
    expect(action.reason).toMatch(
      /Pending LinkedIn Community Management API approval/i,
    );
    expect(action.requiresConfig).toBe(false);
  });

  // spinstr417 — Threads. Ingestion is wired (read-only).
  // REPLY_PUBLIC_COMMENT is gated on env.THREADS_REPLY_ENABLED
  // AND the connection's stored scopes carrying
  // threads_manage_replies. With the env flag off the resolver
  // pins "publishing is not enabled" regardless of connection.
  it("Threads REPLY_PUBLIC_COMMENT is pinned to 'not enabled' when env flag is off", () => {
    envOverrides.THREADS_REPLY_ENABLED = false;
    const conv = makeConversation({
      provider: "THREADS",
      email: null,
      phone: null,
      messages: [
        { party: "CONTACT", externalMessageId: "ti_reply_1", sourceUrl: null },
      ],
    });
    const action = findAction(
      getAvailableReplyActions(conv, {
        threadsConnection: {
          status: "CONNECTED",
          externalAccountId: "100",
          scopes: ["threads_basic", "threads_manage_replies"],
        },
      }),
      "REPLY_PUBLIC_COMMENT",
    );
    expect(action.available).toBe(false);
    expect(action.reason).toMatch(/Threads reply publishing is not enabled/i);
  });

  it("Threads REPLY_PUBLIC_COMMENT asks to reconnect when env on but scope missing", () => {
    envOverrides.THREADS_REPLY_ENABLED = true;
    const conv = makeConversation({
      provider: "THREADS",
      email: null,
      phone: null,
      messages: [
        { party: "CONTACT", externalMessageId: "ti_reply_1", sourceUrl: null },
      ],
    });
    const action = findAction(
      getAvailableReplyActions(conv, {
        threadsConnection: {
          status: "CONNECTED",
          externalAccountId: "100",
          scopes: ["threads_basic"],
        },
      }),
      "REPLY_PUBLIC_COMMENT",
    );
    expect(action.available).toBe(false);
    expect(action.reason).toMatch(/threads_manage_replies/);
  });

  it("Threads REPLY_PUBLIC_COMMENT flips to available with env on + scope granted", () => {
    envOverrides.THREADS_REPLY_ENABLED = true;
    const conv = makeConversation({
      provider: "THREADS",
      email: null,
      phone: null,
      messages: [
        { party: "CONTACT", externalMessageId: "ti_reply_1", sourceUrl: null },
      ],
    });
    const action = findAction(
      getAvailableReplyActions(conv, {
        threadsConnection: {
          status: "CONNECTED",
          externalAccountId: "100",
          scopes: [
            "threads_basic",
            "threads_read_replies",
            "threads_manage_replies",
          ],
        },
      }),
      "REPLY_PUBLIC_COMMENT",
    );
    expect(action.available).toBe(true);
    expect(action.reason).toBeNull();
  });

  it("LinkedIn REPLY_DM is pinned to the same Community Management API pending reason", () => {
    const conv = makeConversation({
      provider: "LINKEDIN",
      email: null,
      phone: null,
      externalThreadId: "urn:li:thread:1",
    });
    const action = findAction(getAvailableReplyActions(conv), "REPLY_DM");
    expect(action.available).toBe(false);
    expect(action.reason).toMatch(
      /Pending LinkedIn Community Management API approval/i,
    );
  });

  it("Instagram gets comment only — DMs out of scope; defaults to Connect-Instagram copy when no connection", () => {
    // Post-outbound-adapter: DMs still out of scope (IG-03 lock).
    // REPLY_PUBLIC_COMMENT stays in the action list because OAuth
    // requests instagram_business_manage_comments. With no
    // connection passed in extras the resolver returns the
    // Connect-Instagram copy with requiresConfig=true.
    const conv = makeConversation({
      provider: "INSTAGRAM",
      email: null,
      phone: null,
      messages: [
        {
          party: "CONTACT",
          externalMessageId: "ig_comment_17856789012345678",
          sourceUrl: null,
        },
      ],
    });
    const actions = getAvailableReplyActions(conv);
    const commentAction = findAction(actions, "REPLY_PUBLIC_COMMENT");
    expect(commentAction).toBeTruthy();
    expect(commentAction.available).toBe(false);
    expect(commentAction.requiresConfig).toBe(true);
    expect(commentAction.reason).toMatch(/Connect Instagram/i);
    expect(findAction(actions, "REPLY_DM")).toBeNull();
    expect(findAction(actions, "REPLY_REVIEW")).toBeNull();
  });

  it("Instagram REPLY_PUBLIC_COMMENT flips to available when connection grants instagram_business_manage_comments", () => {
    const conv = makeConversation({
      provider: "INSTAGRAM",
      email: null,
      phone: null,
      messages: [
        { party: "CONTACT", externalMessageId: "ig_comment_17856789012345678" },
      ],
    });
    const actions = getAvailableReplyActions(conv, {
      instagramConnection: {
        id: "conn-ig-1",
        status: "CONNECTED",
        externalAccountId: "17841444444444444",
        scopes: [
          "instagram_business_basic",
          "instagram_business_content_publish",
          "instagram_business_manage_insights",
          "instagram_business_manage_comments",
        ],
      },
    });
    const comment = findAction(actions, "REPLY_PUBLIC_COMMENT");
    expect(comment.available).toBe(true);
    expect(comment.reason).toBeNull();
    expect(comment.requiresConfig).toBe(false);
  });

  it("Instagram REPLY_PUBLIC_COMMENT stays disabled with reconnect copy on legacy-only scope set", () => {
    const conv = makeConversation({
      provider: "INSTAGRAM",
      email: null,
      phone: null,
      messages: [
        { party: "CONTACT", externalMessageId: "ig_comment_17856789012345678" },
      ],
    });
    const actions = getAvailableReplyActions(conv, {
      instagramConnection: {
        id: "conn-ig-1",
        status: "CONNECTED",
        externalAccountId: "17841444444444444",
        scopes: [
          // Pre-migration scope set — should NOT satisfy the gate.
          "instagram_basic",
          "instagram_content_publish",
          "instagram_manage_insights",
          "instagram_manage_comments",
        ],
      },
    });
    const comment = findAction(actions, "REPLY_PUBLIC_COMMENT");
    expect(comment.available).toBe(false);
    expect(comment.requiresConfig).toBe(true);
    expect(comment.reason).toMatch(/instagram_business_manage_comments/);
    expect(comment.reason).toMatch(/Reconnect Instagram/i);
  });
});

// ── Universal actions ──────────────────────────────────────────────────

describe("getAvailableReplyActions — always-on actions", () => {
  it("returns LOG_EXTERNAL_REPLY and INTERNAL_NOTE for every conversation", () => {
    for (const provider of [
      "SQUADSITES",
      "EMAIL",
      "FACEBOOK",
      "GOOGLE_BUSINESS",
      "MANUAL",
    ]) {
      const actions = getAvailableReplyActions(
        makeConversation({ provider, email: null, phone: null }),
      );
      const logExt = findAction(actions, "LOG_EXTERNAL_REPLY");
      const note = findAction(actions, "INTERNAL_NOTE");
      expect(logExt).toBeTruthy();
      expect(logExt.available).toBe(true);
      expect(note).toBeTruthy();
      expect(note.available).toBe(true);
    }
  });

  it("returns [] for a null/undefined conversation rather than throwing", () => {
    expect(getAvailableReplyActions(null)).toEqual([]);
    expect(getAvailableReplyActions(undefined)).toEqual([]);
  });

  it("falls back to the MANUAL capability set for an unknown provider value", () => {
    const conv = makeConversation({ provider: "NEW_FANGLED_NETWORK" });
    const actions = getAvailableReplyActions(conv);
    // MANUAL supports email + sms, so both should appear.
    expect(findAction(actions, "SEND_EMAIL")).toBeTruthy();
    expect(findAction(actions, "SEND_SMS")).toBeTruthy();
    expect(findAction(actions, "LOG_EXTERNAL_REPLY")).toBeTruthy();
  });
});
