// Intake service tests — verify a FormSubmission becomes a
// Contact + Conversation + initial Message, that the pipeline is
// idempotent on Conversation.sourceFormSubmissionId, and that
// submissions with no contact channels skip cleanly.
//
// Follows the prisma-mocking pattern from tenantIsolation.test.js
// so the suite stays fast (no DB boot).

import { describe, it, expect, vi, beforeEach } from "vitest";

const CLIENT_ID = "client-x";
const SUBMISSION_ID = "sub-1";
const FORM_ID = "form-1";
const PAGE_ID = "page-1";
const CAMPAIGN_ID = "camp-1";

function makeSubmission(overrides = {}) {
  return {
    id: SUBMISSION_ID,
    clientId: CLIENT_ID,
    formId: FORM_ID,
    pageId: PAGE_ID,
    campaignId: CAMPAIGN_ID,
    contactEmail: "alice@example.com",
    contactPhone: null,
    dataJson: {
      name: "Alice Smith",
      email: "alice@example.com",
      message: "Hi, interested in the property.",
      preferredViewingTime: "Saturday afternoon",
    },
    createdAt: new Date("2026-05-14T15:30:00.000Z"),
    ...overrides,
  };
}

// Fresh prisma mock per test so call counts don't leak across cases.
function createPrismaMock(initialState = {}) {
  const state = {
    conversations: new Map(),
    contacts: new Map(),
    messages: [],
    ...initialState,
  };
  // ids handed out by create — deterministic so assertions stay stable
  let convCounter = 0;
  let contactCounter = 0;
  let messageCounter = 0;

  return {
    state,
    conversation: {
      findUnique: vi.fn(async ({ where }) => {
        // Indexed by sourceFormSubmissionId for the idempotency check.
        if (where.sourceFormSubmissionId) {
          for (const c of state.conversations.values()) {
            if (c.sourceFormSubmissionId === where.sourceFormSubmissionId) return c;
          }
          return null;
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        const id = `conv-${++convCounter}`;
        const row = { id, ...data };
        state.conversations.set(id, row);
        return row;
      }),
    },
    contact: {
      findUnique: vi.fn(async ({ where }) => {
        // Either { clientId_email: { clientId, email } } or
        // { clientId_phone: { clientId, phone } } — these are the
        // compound unique keys defined on the Contact model.
        const k = where.clientId_email ?? where.clientId_phone;
        if (!k) return null;
        for (const c of state.contacts.values()) {
          if (c.clientId !== k.clientId) continue;
          if (where.clientId_email && c.email === k.email) return c;
          if (where.clientId_phone && c.phone === k.phone) return c;
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        const id = `contact-${++contactCounter}`;
        const row = { id, ...data };
        state.contacts.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.contacts.get(where.id);
        if (!row) throw new Error(`contact ${where.id} not found`);
        const updated = { ...row, ...data };
        state.contacts.set(where.id, updated);
        return updated;
      }),
    },
    message: {
      create: vi.fn(async ({ data }) => {
        const id = `msg-${++messageCounter}`;
        const row = { id, ...data };
        state.messages.push(row);
        return row;
      }),
    },
  };
}

let prismaMock;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { intakeFormSubmission } = await import(
  "../domains/inbox/inbox.intake.service.js"
);

describe("intakeFormSubmission", () => {
  beforeEach(() => {
    prismaMock = createPrismaMock();
  });

  it("creates Contact + Conversation + initial Message for a fresh submission", async () => {
    const result = await intakeFormSubmission(makeSubmission());

    expect(result.status).toBe("created");
    expect(result.conversationId).toBeTruthy();
    expect(result.contactId).toBeTruthy();

    // Contact captured from form data
    const contacts = [...prismaMock.state.contacts.values()];
    expect(contacts).toHaveLength(1);
    const contact = contacts[0];
    expect(contact.clientId).toBe(CLIENT_ID);
    expect(contact.email).toBe("alice@example.com");
    expect(contact.name).toBe("Alice Smith");
    expect(contact.firstSeenVia).toBe("FORM");
    expect(contact.firstSeenFormId).toBe(FORM_ID);
    expect(contact.firstSeenPageId).toBe(PAGE_ID);
    expect(contact.firstSeenCampaignId).toBe(CAMPAIGN_ID);
    expect(contact.status).toBe("NEW");

    // Conversation linked to submission and page/campaign
    const convs = [...prismaMock.state.conversations.values()];
    expect(convs).toHaveLength(1);
    const conv = convs[0];
    expect(conv.clientId).toBe(CLIENT_ID);
    expect(conv.contactId).toBe(contact.id);
    expect(conv.sourceType).toBe("FORM");
    expect(conv.sourceFormSubmissionId).toBe(SUBMISSION_ID);
    expect(conv.pageId).toBe(PAGE_ID);
    expect(conv.campaignId).toBe(CAMPAIGN_ID);
    expect(conv.status).toBe("OPEN");
    expect(conv.lastMessageFrom).toBe("CONTACT");

    // Initial inbound message carries the form payload + the prose
    // body derived from the "message" field.
    expect(prismaMock.state.messages).toHaveLength(1);
    const msg = prismaMock.state.messages[0];
    expect(msg.conversationId).toBe(conv.id);
    expect(msg.party).toBe("CONTACT");
    expect(msg.channel).toBe("FORM_SUBMISSION");
    expect(msg.body).toBe("Hi, interested in the property.");
    expect(msg.payloadJson).toEqual(makeSubmission().dataJson);
  });

  it("is idempotent — re-running with the same submission is a no-op", async () => {
    const sub = makeSubmission();
    const first = await intakeFormSubmission(sub);
    const second = await intakeFormSubmission(sub);

    expect(first.status).toBe("created");
    expect(second.status).toBe("already_processed");
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.contactId).toBe(first.contactId);

    // No duplicate rows
    expect(prismaMock.state.conversations.size).toBe(1);
    expect(prismaMock.state.contacts.size).toBe(1);
    expect(prismaMock.state.messages).toHaveLength(1);

    // Idempotency check happens BEFORE any writes the second time
    expect(prismaMock.contact.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.conversation.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
  });

  it("skips submissions with neither email nor phone", async () => {
    const result = await intakeFormSubmission(
      makeSubmission({ contactEmail: null, contactPhone: null }),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("NO_CONTACT_FIELDS");
    expect(result.conversationId).toBeNull();
    expect(result.contactId).toBeNull();

    // Critical: nothing should hit the DB beyond the cheap
    // idempotency probe — Contact/Conversation/Message creates
    // never fire.
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
    expect(prismaMock.conversation.create).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it("uses phone when email is missing, building a phone-keyed Contact", async () => {
    const sub = makeSubmission({
      contactEmail: null,
      contactPhone: "+15551234567",
      dataJson: { phone: "+15551234567", name: "Bob" },
    });

    const result = await intakeFormSubmission(sub);

    expect(result.status).toBe("created");
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.email).toBeNull();
    expect(contact.phone).toBe("+15551234567");
    expect(contact.name).toBe("Bob");
  });

  it("merges enrichment when the same Contact submits a second form", async () => {
    // Seed prior contact via first intake.
    const firstSub = makeSubmission();
    await intakeFormSubmission(firstSub);

    const contactBefore = [...prismaMock.state.contacts.values()][0];

    // Second submission, same email + different submission id.
    const secondSub = makeSubmission({
      id: "sub-2",
      dataJson: { email: "alice@example.com", message: "Following up." },
    });
    const result = await intakeFormSubmission(secondSub);

    expect(result.status).toBe("created");
    // Still one contact, with enrichment.submissions length 2 and
    // status auto-promoted NEW → ENGAGED.
    expect(prismaMock.state.contacts.size).toBe(1);
    const contactAfter = [...prismaMock.state.contacts.values()][0];
    expect(contactAfter.id).toBe(contactBefore.id);
    expect(contactAfter.status).toBe("ENGAGED");
    expect(contactAfter.enrichmentJson?.submissions).toHaveLength(2);

    // But a SECOND conversation + message were created for the new
    // submission — current behavior is "one submission = one
    // conversation" per the createConversationIfMissing comment.
    expect(prismaMock.state.conversations.size).toBe(2);
    expect(prismaMock.state.messages).toHaveLength(2);
  });
});
