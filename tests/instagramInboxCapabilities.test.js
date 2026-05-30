// Phase IG-03 — Instagram inbox capability metadata + resolver
// honesty after the Instagram Business Login OAuth migration.

import { describe, it, expect } from "vitest";
import { providerCapabilities } from "../domains/inbox/providerCapabilities.js";
import { getAvailableReplyActions } from "../domains/inbox/inbox.replyActions.js";

describe("providerCapabilities.INSTAGRAM (post-IG-03)", () => {
  const ig = providerCapabilities.INSTAGRAM;

  it("lists exactly the four instagram_business_* scopes as currentScopes", () => {
    expect(ig.currentScopes).toEqual([
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ]);
  });

  it("does NOT carry any legacy instagram_* scope in currentScopes", () => {
    const banned = [
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_insights",
      "instagram_manage_comments",
      "instagram_manage_messages",
    ];
    for (const s of banned) {
      expect(ig.currentScopes).not.toContain(s);
    }
  });

  it("does NOT carry Facebook Page scopes (those live on FACEBOOK)", () => {
    const fbScopes = [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_engagement",
      "pages_messaging",
      "business_management",
      "read_insights",
    ];
    for (const s of fbScopes) {
      expect(ig.currentScopes).not.toContain(s);
    }
  });

  it("does NOT list any DM / message scope as missing", () => {
    // We are not requesting private Instagram DMs in this App
    // Review pass — instagram_business_manage_messages style
    // scopes must not appear as missingScopes either.
    const dmScopes = [
      "instagram_manage_messages",
      "instagram_business_manage_messages",
    ];
    for (const s of dmScopes) {
      expect(ig.missingScopes).not.toContain(s);
    }
  });

  it("does NOT advertise DM ingest or DM send for the public-comments use case", () => {
    expect(ig.ingestDMs).toBe(false);
    expect(ig.sendDM).toBe(false);
  });

  it("treats public comment reply as not-yet-implemented (honest disabled state)", () => {
    expect(ig.sendPublicReply).toBe(false);
    expect(ig.ingestComments).toBe(false);
  });
});

describe("getAvailableReplyActions — Instagram public comment reply (post-IG-03)", () => {
  function makeIgConversation(overrides = {}) {
    return {
      provider: "INSTAGRAM",
      contact: { name: "Lead", email: null, phone: null },
      messages: [
        {
          party: "CONTACT",
          // A real Instagram comment id so the resolver finds an
          // inbound message to reply to.
          externalMessageId: "ig_comment_17856789012345678",
          createdAt: new Date().toISOString(),
        },
      ],
      ...overrides,
    };
  }

  it("renders REPLY_PUBLIC_COMMENT with Connect-Instagram copy when no IG connection is loaded", () => {
    // Post-outbound-adapter (audit follow-up): the resolver now
    // gates on the connection + scope. Without an instagramConnection
    // in extras it surfaces the truthful "Connect Instagram" CTA
    // (was: the pre-implementation "requires implementation and
    // approval" message).
    const actions = getAvailableReplyActions(makeIgConversation());
    const reply = actions.find((a) => a.action === "REPLY_PUBLIC_COMMENT");
    expect(reply).toBeDefined();
    expect(reply.available).toBe(false);
    expect(reply.requiresConfig).toBe(true);
    expect(reply.reason).toMatch(/Connect Instagram/i);
  });

  it("never surfaces the legacy instagram_manage_comments scope in the reason", () => {
    const actions = getAvailableReplyActions(makeIgConversation());
    const reply = actions.find((a) => a.action === "REPLY_PUBLIC_COMMENT");
    // Substring check: the new scope contains "business_manage",
    // so a stale resolver pointing at the legacy scope would say
    // "instagram_manage_comments" without the business_ prefix.
    expect(reply.reason).not.toMatch(/(^|\W)instagram_manage_comments(\W|$)/);
  });

  it("does NOT offer a REPLY_DM action for Instagram (DMs out of scope)", () => {
    const actions = getAvailableReplyActions(makeIgConversation());
    const dm = actions.find((a) => a.action === "REPLY_DM");
    expect(dm).toBeUndefined();
  });
});
