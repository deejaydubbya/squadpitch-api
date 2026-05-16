// providerCapabilities.js — declarative provider matrix.
//
// These tests pin the SHAPE of the matrix so accidental drift (a
// missing field, a typo'd provider key, a stray scope) is caught
// rather than discovered when the UI silently shows the wrong
// affordance. Every entry must declare every boolean — provider
// audits surface what we CAN do and what we explicitly CANNOT do.

import { describe, it, expect } from "vitest";
import {
  providerCapabilities,
  capabilityFor,
  RECOMMENDED_ORDER,
} from "../domains/inbox/providerCapabilities.js";

const REQUIRED_KEYS = [
  "label",
  "ingestComments",
  "ingestDMs",
  "ingestReviews",
  "sendPublicReply",
  "sendDM",
  "sendReview",
  "webhooks",
  "polling",
  "currentScopes",
  "missingScopes",
  "appReviewStatus",
  "notes",
];

const BOOLEAN_KEYS = [
  "ingestComments",
  "ingestDMs",
  "ingestReviews",
  "sendPublicReply",
  "sendDM",
  "sendReview",
  "webhooks",
  "polling",
];

const VALID_APP_REVIEW_STATUS = new Set([
  "live",
  "submitted",
  "not-submitted",
]);

describe("providerCapabilities — matrix shape", () => {
  it("every provider declares every required field", () => {
    for (const [provider, caps] of Object.entries(providerCapabilities)) {
      for (const key of REQUIRED_KEYS) {
        expect(caps[key], `${provider}.${key} missing`).toBeDefined();
      }
    }
  });

  it("every capability flag is a strict boolean (no nulls / strings)", () => {
    for (const [provider, caps] of Object.entries(providerCapabilities)) {
      for (const key of BOOLEAN_KEYS) {
        expect(
          typeof caps[key],
          `${provider}.${key} should be boolean`,
        ).toBe("boolean");
      }
    }
  });

  it("appReviewStatus is one of {live, submitted, not-submitted}", () => {
    for (const [provider, caps] of Object.entries(providerCapabilities)) {
      expect(
        VALID_APP_REVIEW_STATUS.has(caps.appReviewStatus),
        `${provider}.appReviewStatus=${caps.appReviewStatus}`,
      ).toBe(true);
    }
  });

  it("currentScopes and missingScopes are arrays of non-empty strings", () => {
    for (const [provider, caps] of Object.entries(providerCapabilities)) {
      expect(Array.isArray(caps.currentScopes)).toBe(true);
      expect(Array.isArray(caps.missingScopes)).toBe(true);
      for (const scope of caps.currentScopes.concat(caps.missingScopes)) {
        expect(typeof scope).toBe("string");
        expect(scope.length).toBeGreaterThan(0);
      }
    }
  });

  it("notes are present and substantive for every provider", () => {
    for (const [provider, caps] of Object.entries(providerCapabilities)) {
      expect(typeof caps.notes).toBe("string");
      expect(caps.notes.length, `${provider}.notes too short`).toBeGreaterThan(20);
    }
  });
});

describe("providerCapabilities — proven email contract", () => {
  it("EMAIL is the only provider currently flagged as both send-DM AND live + zero missing scopes", () => {
    const sendCapableLive = Object.entries(providerCapabilities)
      .filter(([, caps]) =>
        caps.sendDM &&
        caps.appReviewStatus === "live" &&
        caps.missingScopes.length === 0,
      )
      .map(([k]) => k);
    // SQUADSITES intake doesn't send. SMS has the env but no adapter.
    // Anything else flipping to this state should be a deliberate
    // schema-aware code change (and will need to add a real adapter).
    expect(sendCapableLive).toEqual(["EMAIL"]);
  });

  it("SquadSites form intake never reports send capability", () => {
    const caps = providerCapabilities.SQUADSITES;
    expect(caps.sendPublicReply).toBe(false);
    expect(caps.sendDM).toBe(false);
    expect(caps.sendReview).toBe(false);
  });
});

describe("providerCapabilities — scope hygiene", () => {
  it("Threads already has the reply scopes the future adapter needs", () => {
    expect(providerCapabilities.THREADS.currentScopes).toContain(
      "threads_manage_replies",
    );
    expect(providerCapabilities.THREADS.currentScopes).toContain(
      "threads_read_replies",
    );
    expect(providerCapabilities.THREADS.missingScopes).toEqual([]);
  });

  it("LinkedIn org scopes are already sufficient for comments", () => {
    expect(providerCapabilities.LINKEDIN_ORG.currentScopes).toContain(
      "r_organization_social",
    );
    expect(providerCapabilities.LINKEDIN_ORG.currentScopes).toContain(
      "w_organization_social",
    );
    expect(providerCapabilities.LINKEDIN_ORG.missingScopes).toEqual([]);
  });

  it("Facebook comments / DMs are gated on the right missing scopes", () => {
    const fb = providerCapabilities.FACEBOOK;
    expect(fb.missingScopes).toContain("pages_read_user_content");
    expect(fb.missingScopes).toContain("pages_manage_engagement");
    expect(fb.missingScopes).toContain("pages_messaging");
  });

  it("Instagram comments / DMs are gated on instagram_manage_*", () => {
    const ig = providerCapabilities.INSTAGRAM;
    expect(ig.missingScopes).toContain("instagram_manage_comments");
    expect(ig.missingScopes).toContain("instagram_manage_messages");
  });

  it("YouTube reply is gated on youtube.force-ssl", () => {
    const yt = providerCapabilities.YOUTUBE;
    expect(yt.missingScopes).toContain(
      "https://www.googleapis.com/auth/youtube.force-ssl",
    );
  });

  it("Google Business Profile is gated on business.manage", () => {
    const gbp = providerCapabilities.GOOGLE_BUSINESS;
    expect(gbp.missingScopes).toContain(
      "https://www.googleapis.com/auth/business.manage",
    );
  });

  // spinstr411 — channel registry surfacing only; no real send/poll
  // behavior should be flagged on until prompt 11.
  it("Google Business Profile has all send/ingest flags FALSE (setup-only state)", () => {
    const gbp = providerCapabilities.GOOGLE_BUSINESS;
    expect(gbp.ingestReviews).toBe(false);
    expect(gbp.sendReview).toBe(false);
    expect(gbp.ingestComments).toBe(false);
    expect(gbp.ingestDMs).toBe(false);
    expect(gbp.sendPublicReply).toBe(false);
    expect(gbp.sendDM).toBe(false);
    // Polling stays true — that's a property of the channel, not a
    // toggle. Reviews polling will be wired in the follow-up prompt.
    expect(gbp.polling).toBe(true);
    expect(gbp.webhooks).toBe(false);
    expect(gbp.appReviewStatus).toBe("not-submitted");
  });
});

describe("providerCapabilities — helpers", () => {
  it("capabilityFor returns the matching entry", () => {
    expect(capabilityFor("EMAIL").label).toBe("Email (Postmark)");
    expect(capabilityFor("FACEBOOK").label).toBe("Facebook Page");
  });

  it("capabilityFor falls back to MANUAL for unknown providers", () => {
    expect(capabilityFor("BRAND_NEW_NETWORK")).toBe(
      providerCapabilities.MANUAL,
    );
    expect(capabilityFor(null)).toBe(providerCapabilities.MANUAL);
  });
});

describe("RECOMMENDED_ORDER", () => {
  it("starts with EMAIL (the proven channel) and is followed by GOOGLE_BUSINESS", () => {
    expect(RECOMMENDED_ORDER[0]).toBe("EMAIL");
    expect(RECOMMENDED_ORDER[1]).toBe("GOOGLE_BUSINESS");
  });

  it("Facebook / Instagram comments rank above their DM counterparts", () => {
    const fb = RECOMMENDED_ORDER.indexOf("FACEBOOK");
    const fbDm = RECOMMENDED_ORDER.indexOf("FACEBOOK_DMS");
    const ig = RECOMMENDED_ORDER.indexOf("INSTAGRAM");
    const igDm = RECOMMENDED_ORDER.indexOf("INSTAGRAM_DMS");
    expect(fb).toBeGreaterThan(-1);
    expect(fbDm).toBeGreaterThan(fb);
    expect(igDm).toBeGreaterThan(ig);
  });

  it("contains no duplicates", () => {
    expect(new Set(RECOMMENDED_ORDER).size).toBe(RECOMMENDED_ORDER.length);
  });
});
