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
      // Used by the safe-merge phone/email collision check on update.
      // Returns the first matching contact other than the one being
      // updated, or null if there isn't one.
      findFirst: vi.fn(async ({ where }) => {
        for (const c of state.contacts.values()) {
          if (where.clientId && c.clientId !== where.clientId) continue;
          if (where.id?.not && c.id === where.id.not) continue;
          if (where.email !== undefined && c.email !== where.email) continue;
          if (where.phone !== undefined && c.phone !== where.phone) continue;
          return c;
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        // Simulate the Postgres unique constraint enforcement so
        // the intake's collision handling is actually exercised.
        if (data.email) {
          for (const c of state.contacts.values()) {
            if (c.clientId === data.clientId && c.email === data.email) {
              const e = new Error(
                "Unique constraint failed on the fields: (`clientId`,`email`)",
              );
              e.code = "P2002";
              e.meta = { modelName: "Contact", target: ["clientId", "email"] };
              throw e;
            }
          }
        }
        if (data.phone) {
          for (const c of state.contacts.values()) {
            if (c.clientId === data.clientId && c.phone === data.phone) {
              const e = new Error(
                "Unique constraint failed on the fields: (`clientId`,`phone`)",
              );
              e.code = "P2002";
              e.meta = { modelName: "Contact", target: ["clientId", "phone"] };
              throw e;
            }
          }
        }
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
    // Phone is stored normalized (non-digits stripped) so future
    // lookups match across different submission formats.
    expect(contact.phone).toBe("15551234567");
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

  // Regression for the prod bug surfaced 2026-05-15: a new
  // submission with a NEW email but a phone that already belongs to
  // a DIFFERENT contact in the workspace was P2002'ing on
  // (clientId, phone) and silently dropping the lead from Inbox.
  it("falls back to phone-key lookup when email doesn't match (cross-key resolution)", async () => {
    // Seed: existing contact in the workspace with no email and a
    // specific phone.
    const phoneOnlySub = makeSubmission({
      id: "sub-existing",
      contactEmail: null,
      contactPhone: "+15551234567",
      dataJson: { phone: "+15551234567", name: "Phone-only first" },
    });
    await intakeFormSubmission(phoneOnlySub);
    expect(prismaMock.state.contacts.size).toBe(1);
    const existingId = [...prismaMock.state.contacts.values()][0].id;

    // New submission: brand-new email, but SAME phone. Old intake
    // would try contact.create() and P2002 here.
    const sameDifferentEmail = makeSubmission({
      id: "sub-new-email",
      contactEmail: "newperson@example.com",
      contactPhone: "+15551234567",
      dataJson: {
        email: "newperson@example.com",
        phone: "+15551234567",
        name: "Same phone different email",
      },
    });
    const result = await intakeFormSubmission(sameDifferentEmail);

    // Intake succeeds and merges into the existing contact.
    expect(result.status).toBe("created");
    expect(prismaMock.state.contacts.size).toBe(1);
    const merged = [...prismaMock.state.contacts.values()][0];
    expect(merged.id).toBe(existingId);
    // Phone is preserved in normalized form (it was already the
    // existing phone), and the previously-null email is now filled in.
    expect(merged.phone).toBe("15551234567");
    expect(merged.email).toBe("newperson@example.com");
    // Still creates the second conversation + initial message.
    expect(prismaMock.state.conversations.size).toBe(2);
    expect(prismaMock.state.messages).toHaveLength(2);
  });

  it("does not overwrite an existing email when a different one arrives for the same phone", async () => {
    // Existing contact with both email + phone set.
    const firstSub = makeSubmission({
      contactEmail: "owner@example.com",
      contactPhone: "+15551234567",
      dataJson: { email: "owner@example.com", phone: "+15551234567", name: "Owner" },
    });
    await intakeFormSubmission(firstSub);

    // New submission: SAME phone, DIFFERENT email. The intake
    // should not change the existing email (identity preservation).
    const otherSub = makeSubmission({
      id: "sub-other",
      contactEmail: "shared@example.com",
      contactPhone: "+15551234567",
      dataJson: { email: "shared@example.com", phone: "+15551234567" },
    });
    const result = await intakeFormSubmission(otherSub);
    expect(result.status).toBe("created");
    expect(prismaMock.state.contacts.size).toBe(1);
    const merged = [...prismaMock.state.contacts.values()][0];
    expect(merged.email).toBe("owner@example.com"); // not overwritten
    expect(merged.phone).toBe("15551234567");
    // The newly-submitted (but ignored as primary) email is preserved
    // as an alternate so the UI can show "Also submitted with…".
    expect(merged.enrichmentJson?.alternateEmails).toContain("shared@example.com");
  });

  it("does not overwrite an existing phone when a different one arrives for the same email", async () => {
    const firstSub = makeSubmission({
      contactEmail: "person@example.com",
      contactPhone: "+15551111111",
      dataJson: { email: "person@example.com", phone: "+15551111111", name: "P" },
    });
    await intakeFormSubmission(firstSub);

    const otherSub = makeSubmission({
      id: "sub-other-phone",
      contactEmail: "person@example.com",
      contactPhone: "+15552222222",
      dataJson: { email: "person@example.com", phone: "+15552222222" },
    });
    const result = await intakeFormSubmission(otherSub);
    expect(result.status).toBe("created");
    const merged = [...prismaMock.state.contacts.values()][0];
    expect(merged.email).toBe("person@example.com");
    expect(merged.phone).toBe("15551111111"); // not overwritten
    // The newly-submitted (but ignored as primary) phone is
    // preserved as an alternate.
    expect(merged.enrichmentJson?.alternatePhones).toContain("15552222222");
  });

  // ── Identity normalization + alternate preservation (spinstr404) ──

  it("normalizes email case + phone formatting for matching", async () => {
    // Seed contact with one form, then submit again with a
    // different-cased email and a +-prefixed phone — both should
    // resolve to the same Contact via normalized lookup.
    await intakeFormSubmission(
      makeSubmission({
        contactEmail: "lead@example.com",
        contactPhone: "5551234567",
        dataJson: { email: "lead@example.com", phone: "5551234567" },
      }),
    );
    expect(prismaMock.state.contacts.size).toBe(1);

    const result = await intakeFormSubmission(
      makeSubmission({
        id: "sub-norm",
        contactEmail: "LEAD@EXAMPLE.COM",
        contactPhone: "(555) 123-4567",
        dataJson: { email: "LEAD@EXAMPLE.COM", phone: "(555) 123-4567" },
      }),
    );
    expect(result.status).toBe("created");
    // Still one contact — normalized matching collapses both forms.
    expect(prismaMock.state.contacts.size).toBe(1);
  });

  it("FormSubmission row preserves the exact submitted email + phone (intake never touches it)", async () => {
    // The intake service never updates FormSubmission — that table
    // is written by sites.service.createFormSubmission. Confirm
    // we don't accidentally call any update path that would
    // overwrite the raw submitted values stored there.
    const rawEmail = "Daniel.Wardlow+SquadPitch@Squadpitch.com";
    const rawPhone = "+1 (555) 123-4567 x99";
    const sub = makeSubmission({
      contactEmail: rawEmail,
      contactPhone: rawPhone,
      dataJson: { email: rawEmail, phone: rawPhone },
    });
    await intakeFormSubmission(sub);

    // Submission object retains the exact strings the user typed
    // (we passed them in via fixture; nothing in intake mutates them).
    expect(sub.contactEmail).toBe(rawEmail);
    expect(sub.contactPhone).toBe(rawPhone);
    // But the Contact row stores normalized values for matching.
    const contact = [...prismaMock.state.contacts.values()][0];
    expect(contact.email).toBe("daniel.wardlow+squadpitch@squadpitch.com");
    expect(contact.phone).toBe("1555123456799");
  });

  it("does NOT auto-merge two contacts when only the name matches (no email/phone overlap)", async () => {
    // First submission: name "Alice Smith", email A, phone A.
    await intakeFormSubmission(
      makeSubmission({
        id: "sub-aliceA",
        contactEmail: "alice@one.com",
        contactPhone: "5550001111",
        dataJson: { name: "Alice Smith", email: "alice@one.com", phone: "5550001111" },
      }),
    );
    // Second submission: SAME name, DIFFERENT email AND phone.
    await intakeFormSubmission(
      makeSubmission({
        id: "sub-aliceB",
        contactEmail: "alice@two.com",
        contactPhone: "5559998888",
        dataJson: { name: "Alice Smith", email: "alice@two.com", phone: "5559998888" },
      }),
    );

    // Two contacts — name alone never auto-merges.
    expect(prismaMock.state.contacts.size).toBe(2);
  });

  it("a typo'd email does not overwrite an existing primary email", async () => {
    // Seed contact with valid email + phone.
    await intakeFormSubmission(
      makeSubmission({
        id: "sub-original",
        contactEmail: "alice@example.com",
        contactPhone: "5551234567",
        dataJson: { email: "alice@example.com", phone: "5551234567" },
      }),
    );

    // Repeat submission: SAME phone, TYPO email.
    await intakeFormSubmission(
      makeSubmission({
        id: "sub-typo",
        contactEmail: "alce@example.com", // typo
        contactPhone: "5551234567",
        dataJson: { email: "alce@example.com", phone: "5551234567" },
      }),
    );

    // Phone-lookup matches the original contact. Email stays as-is
    // (never overwritten); the typo lives in alternates.
    expect(prismaMock.state.contacts.size).toBe(1);
    const merged = [...prismaMock.state.contacts.values()][0];
    expect(merged.email).toBe("alice@example.com");
    expect(merged.enrichmentJson?.alternateEmails).toContain("alce@example.com");
  });
});
