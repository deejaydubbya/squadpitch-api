// Google Business Profile review ingestion — persistence layer
// only (no HTTP fetch; no Graph API). The future polling worker
// will hand normalized review payloads to ingestGbpReview() and
// these tests pin the persistence + idempotency + tenant-isolation
// contracts that worker will rely on.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { ingestGbpReview } = await import(
  "../domains/inbox/inbox.gbp.ingestion.service.js"
);

const CLIENT_ID = "client-gbp-1";
const LOCATION_NAME = "accounts/100/locations/200";
const REVIEW_ID = `${LOCATION_NAME}/reviews/r-xyz-001`;

function createPrismaMock({ noConnection = false } = {}) {
  const conversations = new Map();
  const contacts = new Map();
  const messages = [];
  const connections = new Map();
  if (!noConnection) {
    connections.set(`GOOGLE_BUSINESS_PROFILE:${LOCATION_NAME}`, {
      id: "conn-gbp",
      clientId: CLIENT_ID,
      channel: "GOOGLE_BUSINESS_PROFILE",
      externalAccountId: LOCATION_NAME,
      status: "CONNECTED",
      scopes: ["https://www.googleapis.com/auth/business.manage"],
      updatedAt: new Date(),
    });
  }
  let convCounter = 0;
  let contactCounter = 0;
  let messageCounter = 0;
  return {
    state: { conversations, contacts, messages, connections },
    channelConnection: {
      findMany: vi.fn(async ({ where }) => {
        const key = `${where.channel}:${where.externalAccountId}`;
        const row = connections.get(key);
        if (!row) return [];
        if (where.status && row.status !== where.status) return [];
        return [row];
      }),
    },
    message: {
      findFirst: vi.fn(async ({ where }) => {
        if (!where.externalMessageId) return null;
        const m = messages.find((x) => x.externalMessageId === where.externalMessageId);
        if (!m) return null;
        const conv = conversations.get(m.conversationId);
        if (where.conversation?.clientId && conv?.clientId !== where.conversation.clientId)
          return null;
        if (where.conversation?.provider && conv?.provider !== where.conversation.provider)
          return null;
        return { id: m.id, conversationId: m.conversationId };
      }),
      create: vi.fn(async ({ data }) => {
        const id = `msg-${++messageCounter}`;
        const row = { id, createdAt: data.createdAt instanceof Date ? data.createdAt : new Date(), ...data };
        messages.push(row);
        return row;
      }),
    },
    conversation: {
      create: vi.fn(async ({ data }) => {
        const id = `conv-${++convCounter}`;
        const row = { id, ...data };
        conversations.set(id, row);
        return row;
      }),
    },
    contact: {
      findFirst: vi.fn(async ({ where }) => {
        for (const c of contacts.values()) {
          if (where.clientId && c.clientId !== where.clientId) continue;
          if (where.enrichmentJson?.path) {
            const [head, sub] = where.enrichmentJson.path;
            if (c.enrichmentJson?.[head]?.[sub] === where.enrichmentJson.equals) return c;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        const id = `contact-${++contactCounter}`;
        const row = { id, ...data };
        contacts.set(id, row);
        return row;
      }),
    },
  };
}

beforeEach(() => {
  prismaMock = createPrismaMock();
});

function makeReview(overrides = {}) {
  return {
    locationName: LOCATION_NAME,
    reviewId: REVIEW_ID,
    starRating: 5,
    comment: "Great service, would come back!",
    reviewer: {
      googleId: "google-user-42",
      displayName: "Daniel W.",
      isAnonymous: false,
    },
    createTime: "2026-05-16T10:00:00Z",
    updateTime: "2026-05-16T10:00:00Z",
    sourceUrl: "https://search.google.com/local/reviews?placeid=ABC",
    ...overrides,
  };
}

// ── Happy path ─────────────────────────────────────────────────────────

describe("ingestGbpReview — happy path", () => {
  it("creates a Conversation with provider=GOOGLE_BUSINESS, sourceType=REVIEW, visibility=PUBLIC", async () => {
    const result = await ingestGbpReview(makeReview());
    expect(result.status).toBe("created");
    const conv = [...prismaMock.state.conversations.values()][0];
    expect(conv.clientId).toBe(CLIENT_ID);
    expect(conv.provider).toBe("GOOGLE_BUSINESS");
    expect(conv.sourceType).toBe("REVIEW");
    expect(conv.externalThreadId).toContain(LOCATION_NAME);
    expect(conv.externalThreadId).toContain(REVIEW_ID);
    const msg = prismaMock.state.messages[0];
    expect(msg.party).toBe("CONTACT");
    expect(msg.visibility).toBe("PUBLIC");
    expect(msg.externalMessageId).toBe(REVIEW_ID);
    expect(msg.providerMessageId).toBe(REVIEW_ID);
    expect(msg.sourceUrl).toMatch(/search\.google\.com/);
  });

  it("renders the star rating into the body alongside the comment", async () => {
    await ingestGbpReview(makeReview({ starRating: 4 }));
    const msg = prismaMock.state.messages[0];
    expect(msg.body).toContain("★★★★☆");
    expect(msg.body).toContain("Great service");
  });

  it("emits a body even when the review has no comment (star-only reviews)", async () => {
    await ingestGbpReview(makeReview({ comment: null }));
    const msg = prismaMock.state.messages[0];
    expect(msg.body).toContain("★★★★★");
    expect(msg.body).toContain("(no comment)");
  });

  it("creates a Contact identified by reviewer.googleId (no email/phone surfaced)", async () => {
    await ingestGbpReview(makeReview());
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.email).toBeNull();
    expect(contact.phone).toBeNull();
    expect(contact.name).toBe("Daniel W.");
    expect(contact.firstSeenVia).toBe("SOCIAL");
    expect(contact.enrichmentJson?.externalIds?.GOOGLE_BUSINESS).toBe("google-user-42");
  });

  it('synthesizes a stable identifier for anonymous "A Google User" reviewers', async () => {
    const review = makeReview({
      reviewer: { googleId: null, displayName: "A Google User", isAnonymous: true },
    });
    await ingestGbpReview(review);
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.enrichmentJson.externalIds.GOOGLE_BUSINESS).toMatch(/^anon:/);
    expect(contact.enrichmentJson.isAnonymous).toBe(true);
  });

  it("stores a sanitized payloadJson — no arbitrary Google fields echoed", async () => {
    await ingestGbpReview(makeReview());
    const msg = prismaMock.state.messages[0];
    expect(msg.payloadJson).toMatchObject({
      reviewId: REVIEW_ID,
      locationName: LOCATION_NAME,
      starRating: 5,
      reviewer: { googleId: "google-user-42", displayName: "Daniel W." },
    });
  });
});

// ── Idempotency ────────────────────────────────────────────────────────

describe("ingestGbpReview — idempotency", () => {
  it("returns duplicate on a repeated call with the same review id (no extra rows)", async () => {
    const r1 = await ingestGbpReview(makeReview());
    expect(r1.status).toBe("created");
    const r2 = await ingestGbpReview(makeReview());
    expect(r2.status).toBe("duplicate");
    expect(r2.conversationId).toBe(r1.conversationId);
    expect(r2.messageId).toBe(r1.messageId);
    expect(prismaMock.state.messages.length).toBe(1);
    expect(prismaMock.state.conversations.size).toBe(1);
  });

  it("creates a NEW row when the review id is different", async () => {
    await ingestGbpReview(makeReview());
    await ingestGbpReview(
      makeReview({ reviewId: `${LOCATION_NAME}/reviews/r-other-002` }),
    );
    expect(prismaMock.state.messages.length).toBe(2);
  });
});

// ── Tenant isolation ───────────────────────────────────────────────────

describe("ingestGbpReview — tenant isolation", () => {
  it("returns skipped/UNKNOWN_ACCOUNT when no ChannelConnection matches the location", async () => {
    prismaMock = createPrismaMock({ noConnection: true });
    const result = await ingestGbpReview(makeReview());
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("UNKNOWN_ACCOUNT");
    expect(prismaMock.state.messages.length).toBe(0);
    expect(prismaMock.state.contacts.size).toBe(0);
  });
});

// ── Defensive paths ────────────────────────────────────────────────────

describe("ingestGbpReview — defensive paths", () => {
  it("returns skipped for null / non-object payload", async () => {
    expect((await ingestGbpReview(null)).status).toBe("skipped");
    expect((await ingestGbpReview(undefined)).status).toBe("skipped");
  });

  it("returns skipped/MISSING_LOCATION when locationName is absent", async () => {
    const r = await ingestGbpReview(makeReview({ locationName: undefined }));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("MISSING_LOCATION");
  });

  it("returns skipped/MISSING_REVIEW_ID when reviewId is absent", async () => {
    const r = await ingestGbpReview(makeReview({ reviewId: undefined }));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("MISSING_REVIEW_ID");
  });
});
