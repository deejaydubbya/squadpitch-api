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
  // Prefer email as the identity key (more stable than phone).
  // Fallback to phone when there's no email.
  const lookupKey = email
    ? { clientId_email: { clientId, email } }
    : { clientId_phone: { clientId, phone } };

  const existing = await prisma.contact.findUnique({ where: lookupKey });

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
    // Append the new submission to the enrichment history.
    const merged = mergeEnrichment(existing.enrichmentJson, enrichmentMerge);
    return prisma.contact.update({
      where: { id: existing.id },
      data: {
        // Fill in missing identity fields if we now have them.
        email: existing.email ?? email ?? null,
        phone: existing.phone ?? phone ?? null,
        name: existing.name ?? inferredName,
        enrichmentJson: merged,
        // Repeat lead — flip to ENGAGED unless the user already
        // promoted them further.
        status:
          existing.status === "NEW" ? "ENGAGED" : existing.status,
      },
    });
  }

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
