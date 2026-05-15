// Inbox AI reply context tests.
//
// Verifies the fix for the context-blind reply bug: when a
// conversation came in from a specific page or campaign with a
// linked WorkspaceDataItem, the prompt fed to OpenAI must include
// the page/property facts so the model can answer the lead's
// question instead of asking "which home?". Captures the prompt
// at the generateStructuredContent boundary and asserts on its
// contents — no real OpenAI traffic, no DB connection.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────

// Shared mutable fixtures + capture buffer for the generated prompt.
let fixtures;
let captured;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return fixtures.prisma;
  },
}));

vi.mock("../domains/studio/generation/clientOrchestrator.js", () => ({
  loadClientGenerationContext: vi.fn(async () => ({
    client: { name: "Smith Realty" },
    brand: { tagline: "Helping you find home.", valueProposition: null },
    voice: { tone: "warm", style: "concise" },
  })),
}));

vi.mock("../domains/studio/generation/openai.provider.js", () => ({
  generateStructuredContent: vi.fn(async ({ systemPrompt, userPrompt }) => {
    captured.systemPrompt = systemPrompt;
    captured.userPrompt = userPrompt;
    return {
      parsed: { body: "Stub reply body.", tone: "professional" },
      model: "gpt-stub-test",
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    };
  }),
}));

vi.mock("../domains/billing/aiUsageTracking.service.js", () => ({
  trackAiUsage: vi.fn(),
}));

const { generateAiReply, loadAiReplyContext } = await import(
  "../domains/inbox/inbox.service.js"
);

// ── Fixture builders ────────────────────────────────────────────────────

const CLIENT_ID = "client-1";
const CONV_ID = "conv-1";

function makeConversation(overrides = {}) {
  return {
    id: CONV_ID,
    clientId: CLIENT_ID,
    contactId: "contact-1",
    pageId: null,
    campaignId: null,
    sourceFormSubmissionId: null,
    contact: {
      id: "contact-1",
      name: "Daniel",
      email: "daniel@example.com",
      phone: null,
      status: "NEW",
    },
    messages: [
      {
        id: "m-1",
        party: "CONTACT",
        channel: "FORM_SUBMISSION",
        body: "How much is this home selling for?",
        createdAt: new Date("2026-05-14T10:00:00Z"),
      },
    ],
    ...overrides,
  };
}

function buildPrismaMock({
  conversation,
  page = null,
  campaign = null,
  submission = null,
  dataItem = null,
}) {
  return {
    conversation: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.id !== conversation.id || where.clientId !== conversation.clientId)
          return null;
        return conversation;
      }),
    },
    sitePage: {
      findUnique: vi.fn(async ({ where }) => (page && where.id === page.id ? page : null)),
    },
    campaign: {
      findUnique: vi.fn(async ({ where }) =>
        campaign && where.id === campaign.id ? campaign : null,
      ),
    },
    formSubmission: {
      findUnique: vi.fn(async ({ where }) =>
        submission && where.id === submission.id ? submission : null,
      ),
    },
    workspaceDataItem: {
      findUnique: vi.fn(async ({ where }) =>
        dataItem && where.id === dataItem.id ? dataItem : null,
      ),
    },
    aIReplySuggestion: {
      create: vi.fn(async ({ data }) => ({ id: "sug-1", ...data })),
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("generateAiReply — source context grounding", () => {
  beforeEach(() => {
    captured = {};
  });

  it("feeds property facts (price, address) into the prompt when the page is sourced from a WorkspaceDataItem", async () => {
    const conversation = makeConversation({
      pageId: "page-1",
      sourceFormSubmissionId: "sub-1",
    });
    const page = {
      id: "page-1",
      title: "508 King George Court",
      slug: "508-king-george-court",
      description: "Just listed in Cary, NC.",
      sourceType: "PROPERTY",
      sourceId: "data-1",
      pageGoal: "LISTING",
      seoDescription: null,
      blocksJson: [
        {
          type: "hero",
          headline: "Welcome to 508 King George Court",
          subheadline: "4 bed · 3 bath · Cary, NC",
        },
        {
          type: "key_details",
          items: [
            { label: "Bedrooms", value: "4" },
            { label: "Bathrooms", value: "3" },
            { label: "Sq Ft", value: "2,850" },
          ],
        },
      ],
    };
    const dataItem = {
      id: "data-1",
      type: "PROPERTY",
      title: "508 King George Court",
      summary: "Recently renovated 4-bed in Cary.",
      dataJson: {
        street: "508 King George Court",
        city: "Cary",
        state: "NC",
        zip: "27513",
        price: 365000,
        bedrooms: 4,
        bathrooms: 3,
        sqft: 2850,
        propertyType: "Single Family",
      },
      tags: ["listing"],
    };
    const submission = {
      id: "sub-1",
      dataJson: { message: "How much is this home selling for?", name: "Daniel" },
      createdAt: new Date("2026-05-14T10:00:00Z"),
      form: { id: "form-1", name: "Listing inquiry" },
    };

    fixtures = {
      prisma: buildPrismaMock({ conversation, page, dataItem, submission }),
    };

    const result = await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "professional",
    });
    expect(result.id).toBe("sug-1");

    // The user prompt is what carries the facts. The model sees both.
    const prompt = captured.userPrompt;
    expect(prompt).toContain("508 King George Court");
    expect(prompt).toContain("Price: 365000");
    expect(prompt).toContain("Bedrooms: 4");
    expect(prompt).toContain("Sq ft: 2850");
    // System prompt should carry the anti-clarify directive when
    // source context is present.
    expect(captured.systemPrompt).toMatch(/never ask the lead to clarify/i);
    expect(captured.systemPrompt).toMatch(/never invent a price/i);
  });

  it("warns the model to not invent facts when the property has no price on file", async () => {
    const conversation = makeConversation({ pageId: "page-2" });
    const page = {
      id: "page-2",
      title: "Coming Soon Listing",
      slug: "coming-soon",
      description: null,
      sourceType: "PROPERTY",
      sourceId: "data-2",
      pageGoal: "LISTING",
      seoDescription: null,
      blocksJson: [
        { type: "hero", headline: "Coming Soon", subheadline: "Pricing TBD" },
      ],
    };
    const dataItem = {
      id: "data-2",
      type: "PROPERTY",
      title: "Coming Soon Listing",
      summary: null,
      // No price, no facts — should never be fabricated.
      dataJson: {},
      tags: [],
    };

    fixtures = { prisma: buildPrismaMock({ conversation, page, dataItem }) };

    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "professional",
    });

    expect(captured.userPrompt).not.toMatch(/Price:/);
    expect(captured.userPrompt).toMatch(/No structured facts on file/i);
    expect(captured.systemPrompt).toMatch(/never invent a price/i);
  });

  it("includes campaign source context when no page is linked", async () => {
    const conversation = makeConversation({ campaignId: "camp-1" });
    const campaign = {
      id: "camp-1",
      name: "Spring Open House Push",
      campaignType: "open_house_push",
      status: "ACTIVE",
      sourceType: "property",
      sourceDataItemId: "data-3",
      sourceTitle: "Property: 12 Maple Lane",
      campaignIdea: "Promote the open house this Saturday.",
    };
    const dataItem = {
      id: "data-3",
      type: "PROPERTY",
      title: "12 Maple Lane",
      summary: null,
      dataJson: { street: "12 Maple Lane", price: 425000, bedrooms: 3 },
      tags: [],
    };

    fixtures = { prisma: buildPrismaMock({ conversation, campaign, dataItem }) };

    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "professional",
    });

    expect(captured.userPrompt).toContain("Spring Open House Push");
    expect(captured.userPrompt).toContain("12 Maple Lane");
    expect(captured.userPrompt).toContain("Price: 425000");
    expect(captured.systemPrompt).toMatch(/specific source page or campaign/i);
  });

  it("falls back to the generic ack rule when there is no page or campaign", async () => {
    const conversation = makeConversation();
    fixtures = { prisma: buildPrismaMock({ conversation }) };

    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", { tone: "friendly" });

    // No "treat the lead's question as referring to..." line.
    expect(captured.systemPrompt).not.toMatch(/specific source page or campaign/i);
    // The original generic line is back.
    expect(captured.systemPrompt).toMatch(
      /Acknowledge the specific page\/topic they came from when known/i,
    );
  });

  it("loadAiReplyContext handles missing page/campaign without throwing", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        conversation: makeConversation({
          pageId: "missing-page",
          campaignId: "missing-camp",
        }),
      }),
    };
    const ctx = await loadAiReplyContext({
      pageId: "missing-page",
      campaignId: "missing-camp",
      sourceFormSubmissionId: null,
    });
    expect(ctx).toEqual({
      page: null,
      campaign: null,
      submission: null,
      dataItem: null,
    });
  });
});

// ── Channel-aware grounding (spinstr06) ────────────────────────────────
//
// The composer has three surfaces (Send email / Log reply / Internal
// note); the AI suggester needs to know which because the right
// shape of output differs:
//   email — "Hi <name>, ..." with a sign-off-ready next step
//   reply — terse paste-into-another-tool; no greeting/sign-off
//   note  — third-person team note about the lead
//
// These tests pin the system prompt rules per channel against the
// captured prompt.

describe("generateAiReply — channel framing", () => {
  beforeEach(() => {
    captured = {};
    fixtures = {
      prisma: buildPrismaMock({ conversation: makeConversation() }),
    };
  });

  it("email channel frames the draft as a real outbound email reply with greeting", async () => {
    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "professional",
      channel: "email",
    });
    expect(captured.systemPrompt).toMatch(/single email reply/i);
    expect(captured.systemPrompt).toMatch(/Address the lead by first name/i);
    expect(captured.systemPrompt).toMatch(
      /End with a concrete next step/i,
    );
  });

  it("note channel produces a third-person team note (no greeting)", async () => {
    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "professional",
      channel: "note",
    });
    // Third-person framing + explicit no-greeting rule.
    expect(captured.systemPrompt).toMatch(/internal note/i);
    expect(captured.systemPrompt).toMatch(/third person/i);
    expect(captured.systemPrompt).toMatch(
      /never address them directly/i,
    );
    // The "Hi <first name>" rule is suppressed for notes.
    expect(captured.systemPrompt).not.toMatch(/Address the lead by first name/i);
    // The user prompt closer flips to the note version.
    expect(captured.userPrompt).toMatch(/internal note for the team/i);
  });

  it("reply (logged-external) channel skips the greeting/sign-off", async () => {
    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "concise",
      channel: "reply",
    });
    expect(captured.systemPrompt).toMatch(
      /paste this into another tool/i,
    );
    expect(captured.systemPrompt).toMatch(/No greeting, no sign-off/i);
  });

  it("defaults to email framing when no channel is provided (back-compat)", async () => {
    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "professional",
    });
    expect(captured.systemPrompt).toMatch(/single email reply/i);
  });

  it("public_comment channel produces a short, safe, no-PII reply", async () => {
    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "professional",
      channel: "public_comment",
    });
    expect(captured.systemPrompt).toMatch(/public reply/i);
    // Hard prohibition on leaking lead PII in a public surface.
    expect(captured.systemPrompt).toMatch(
      /Never include the commenter's email, phone, address/i,
    );
    expect(captured.systemPrompt).toMatch(/visible to every viewer/i);
    expect(captured.userPrompt).toMatch(/short public reply/i);
  });

  it("private_dm channel produces a conversational, no-sign-off reply", async () => {
    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "friendly",
      channel: "private_dm",
    });
    expect(captured.systemPrompt).toMatch(/direct message/i);
    expect(captured.systemPrompt).toMatch(/no formal greeting, no sign-off/i);
    // First-name addressing IS allowed in DMs (private surface).
    expect(captured.systemPrompt).toMatch(/Address the lead by first name/i);
    expect(captured.userPrompt).toMatch(/direct message/i);
  });

  it("note + source context summarizes facts for the team rather than the lead", async () => {
    // Same property-page fixture as the price-question test above
    // — but the note framing should reorient the rules toward the
    // team rather than addressing the lead.
    const conversation = makeConversation({
      pageId: "page-note",
      sourceFormSubmissionId: null,
    });
    const page = {
      id: "page-note",
      title: "508 King George Court",
      slug: "508-king-george-court",
      description: null,
      sourceType: "PROPERTY",
      sourceId: "data-note",
      pageGoal: "LISTING",
      seoDescription: null,
      blocksJson: [],
    };
    const dataItem = {
      id: "data-note",
      type: "PROPERTY",
      title: "508 King George Court",
      summary: null,
      dataJson: { price: 365000, bedrooms: 4 },
      tags: [],
    };
    fixtures = { prisma: buildPrismaMock({ conversation, page, dataItem }) };

    await generateAiReply(CLIENT_ID, CONV_ID, "auth0|user", {
      tone: "professional",
      channel: "note",
    });

    // Note-specific source rule replaces the "say you'll check"
    // language with team-facing guidance.
    expect(captured.systemPrompt).toMatch(
      /Summarize what's known from the source facts/i,
    );
    expect(captured.systemPrompt).toMatch(
      /one-line suggested next action for the team/i,
    );
    // Anti-hallucination rule still applies.
    expect(captured.systemPrompt).toMatch(/never invent a price/i);
    // Facts still reach the user prompt.
    expect(captured.userPrompt).toContain("Price: 365000");
  });
});
