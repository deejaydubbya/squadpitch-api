// SquadInbox intake — converts a FormSubmission into a Contact +
// Conversation + initial Message.
//
// Idempotent on Conversation.sourceFormSubmissionId so the path
// is safe to retry or to backfill historical submissions. Same
// service is used both inline from createFormSubmission (MVP)
// and from the seedHistoricalInbox script.
//
// Design constraint: the "one submission = one conversation"
// rule lives in createConversationIfMissing(). To switch to
// "append to existing OPEN conversation" later, replace the body
// of that function — the rest of the service stays the same.

import { prisma } from "../../prisma.js";

/**
 * Process a single FormSubmission row into the Inbox graph.
 *
 * @param {object} submission - prisma FormSubmission row
 * @returns {Promise<{conversationId: string|null, contactId: string|null, status: string, reason?: string}>}
 *   status: 'created' | 'already_processed' | 'skipped'
 */
export async function intakeFormSubmission(submission) {
  if (!submission || typeof submission !== "object") {
    return { conversationId: null, contactId: null, status: "skipped", reason: "BAD_INPUT" };
  }

  // Idempotency check first — cheaper than running the upsert and
  // letting the unique constraint fail. The unique index on
  // sourceFormSubmissionId guarantees correctness either way.
  const existing = await prisma.conversation.findUnique({
    where: { sourceFormSubmissionId: submission.id },
    select: { id: true, contactId: true },
  });
  if (existing) {
    return {
      conversationId: existing.id,
      contactId: existing.contactId,
      status: "already_processed",
    };
  }

  // Contacts are keyed on (clientId, email) OR (clientId, phone).
  // If neither is available, we can't build a Contact — skip
  // intake but log so the SubmissionsPanel still surfaces the
  // raw row.
  const email = nonEmpty(submission.contactEmail);
  const phone = nonEmpty(submission.contactPhone);
  if (!email && !phone) {
    return {
      conversationId: null,
      contactId: null,
      status: "skipped",
      reason: "NO_CONTACT_FIELDS",
    };
  }

  const contact = await upsertContact({
    clientId: submission.clientId,
    email,
    phone,
    submission,
  });

  const conversation = await createConversationIfMissing({
    clientId: submission.clientId,
    contact,
    submission,
  });

  await createInitialMessage({
    conversationId: conversation.id,
    submission,
  });

  return {
    conversationId: conversation.id,
    contactId: contact.id,
    status: "created",
  };
}

// ── Contact upsert ─────────────────────────────────────────────────────

async function upsertContact({ clientId, email, phone, submission }) {
  // Identity resolution. Contact has TWO unique constraints in
  // this workspace — (clientId, email) AND (clientId, phone) — and
  // a single new submission can collide on either. Previous version
  // only looked up by email and then unconditionally created on
  // miss, which P2002'd when another contact had the same phone.
  //
  // New rule: try email first (more stable identity), then phone.
  // Once we have a match, do a safe-merge update that NEVER
  // overwrites an existing identity field — only fills in nulls,
  // and even then verifies the new value isn't already claimed by
  // another contact in the workspace.
  let existing = null;
  if (email) {
    existing = await prisma.contact.findUnique({
      where: { clientId_email: { clientId, email } },
    });
  }
  if (!existing && phone) {
    existing = await prisma.contact.findUnique({
      where: { clientId_phone: { clientId, phone } },
    });
  }

  // Inferred name from the dataJson — best-effort. The intake
  // service doesn't try to be smart about this; the Inbox UI
  // shows the email/phone as the headline if no name was given.
  const inferredName = pickField(submission.dataJson, ["name", "fullName", "full_name", "firstName"]);

  // Merge enrichment without overwriting prior fields. The
  // dataJson from the new submission goes into a tagged sub-key
  // so multiple submissions accumulate.
  const enrichmentMerge = {
    submissions: [
      {
        submissionId: submission.id,
        at: submission.createdAt instanceof Date
          ? submission.createdAt.toISOString()
          : submission.createdAt,
        pageId: submission.pageId,
        campaignId: submission.campaignId,
        data: submission.dataJson,
      },
    ],
  };

  if (existing) {
    const merged = mergeEnrichment(existing.enrichmentJson, enrichmentMerge);
    const data = {
      enrichmentJson: merged,
      // Repeat lead — flip to ENGAGED unless the user already
      // promoted them further.
      status: existing.status === "NEW" ? "ENGAGED" : existing.status,
    };
    if (!existing.name && inferredName) data.name = inferredName;
    // Fill in a missing email — but only if no OTHER contact in
    // this workspace already claims it (would P2002 otherwise).
    if (!existing.email && email) {
      const taken = await prisma.contact.findFirst({
        where: { clientId, email, id: { not: existing.id } },
        select: { id: true },
      });
      if (!taken) data.email = email;
    }
    // Same check for phone.
    if (!existing.phone && phone) {
      const taken = await prisma.contact.findFirst({
        where: { clientId, phone, id: { not: existing.id } },
        select: { id: true },
      });
      if (!taken) data.phone = phone;
    }
    return prisma.contact.update({
      where: { id: existing.id },
      data,
    });
  }

  // Neither key matched an existing contact. Safe to create.
  // A concurrent submission could still race us between the
  // findUniques above and this insert; if it does, P2002 bubbles
  // up to the intake caller and gets logged as a "lost" submission.
  // Future hardening: catch P2002 here and retry upsertContact
  // once.
  return prisma.contact.create({
    data: {
      clientId,
      email: email ?? null,
      phone: phone ?? null,
      name: inferredName,
      firstSeenVia: "FORM",
      firstSeenFormId: submission.formId,
      firstSeenPageId: submission.pageId,
      firstSeenCampaignId: submission.campaignId,
      enrichmentJson: enrichmentMerge,
      status: "NEW",
    },
  });
}

// ── Conversation creation ──────────────────────────────────────────────

// Where the "one submission = one conversation" rule lives. To
// switch to "append to existing OPEN conversation", change this
// function to:
//   const open = await prisma.conversation.findFirst({
//     where: { contactId: contact.id, status: 'OPEN' },
//   });
//   if (open) { ...append a Message; return open... }
// The rest of the service stays the same.
async function createConversationIfMissing({ clientId, contact, submission }) {
  return prisma.conversation.create({
    data: {
      clientId,
      contactId: contact.id,
      sourceType: "FORM",
      sourceFormSubmissionId: submission.id,
      pageId: submission.pageId,
      campaignId: submission.campaignId,
      status: "OPEN",
      // The form submission IS the first message — stamp the
      // timestamps off submission.createdAt so the inbox sort
      // is consistent with the underlying event.
      lastMessageAt: submission.createdAt,
      lastMessageFrom: "CONTACT",
    },
  });
}

// ── Initial message creation ───────────────────────────────────────────

async function createInitialMessage({ conversationId, submission }) {
  const dataJson = (submission.dataJson || {});
  const body = buildInboundBody(dataJson);
  return prisma.message.create({
    data: {
      conversationId,
      party: "CONTACT",
      channel: "FORM_SUBMISSION",
      body,
      payloadJson: dataJson,
      createdAt: submission.createdAt,
    },
  });
}

// Turn the raw form key/value pairs into a short prose body so the
// thread view looks like a real message even without a "message"
// field in the form. The full structured payload is also stored
// in payloadJson so the UI can render a key/value strip.
function buildInboundBody(dataJson) {
  if (!dataJson || typeof dataJson !== "object") return "Submitted a form.";
  // Prefer a free-text "message" field if the form had one.
  const messageField = pickField(dataJson, ["message", "comments", "details", "notes"]);
  if (messageField) return messageField;
  // Otherwise build a compact prose summary from the non-empty
  // fields, skipping the contact fields (already on the Contact row).
  const skip = new Set(["name", "fullName", "full_name", "firstName", "lastName", "email", "phone"]);
  const lines = [];
  for (const [key, value] of Object.entries(dataJson)) {
    if (skip.has(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    lines.push(`${humanizeKey(key)}: ${value.trim()}`);
  }
  if (lines.length === 0) return "Submitted a form.";
  return lines.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────

function nonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function pickField(dataJson, keys) {
  if (!dataJson || typeof dataJson !== "object") return null;
  for (const key of keys) {
    const v = dataJson[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function humanizeKey(key) {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function mergeEnrichment(prev, next) {
  // prev may be null (first time) or an object with shape
  // { submissions: [...], ...future-tagged-keys }.
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
  const submissions = Array.isArray(base.submissions) ? base.submissions : [];
  return {
    ...base,
    submissions: [...submissions, ...(next.submissions || [])],
  };
}
