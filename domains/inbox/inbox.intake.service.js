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
import { enqueueNotification } from "../notifications/notification.service.js";

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
  // Skip when neither is available — OR when the values can't be
  // normalized (e.g. a phone field that came in as "abc" with no
  // digits). FormSubmission keeps the raw value either way; this
  // gate only decides whether to materialize an Inbox surface.
  const email = nonEmpty(submission.contactEmail);
  const phone = nonEmpty(submission.contactPhone);
  const hasUsableIdentity =
    Boolean(normalizeEmailForLookup(email)) ||
    Boolean(normalizePhoneForLookup(phone));
  if (!hasUsableIdentity) {
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

  // Notify the workspace owner about the new lead. Fire-and-forget
  // by design — notification failures must NEVER block the intake
  // (the request would 500 to the public form and the lead would
  // never land in the inbox). enqueueNotification has its own
  // top-level try/catch, but we wrap with an extra .catch as a
  // belt-and-braces guard for the user lookup step.
  notifyNewLead({ submission, conversation, contact }).catch((err) => {
    console.error("[INBOX_INTAKE] notify_new_lead_failed:", {
      conversationId: conversation.id,
      submissionId: submission.id,
      err: err?.message ?? err,
    });
  });

  return {
    conversationId: conversation.id,
    contactId: contact.id,
    status: "created",
  };
}

// ── New-lead notification ──────────────────────────────────────────────

async function notifyNewLead({ submission, conversation, contact }) {
  // Resolve the workspace owner. Client.createdBy holds the Auth0
  // sub of the user who created the workspace; the notification
  // system keys off User.id, so we look that up. Solo workspaces
  // for MVP — multi-user fan-out is a future change.
  const client = await prisma.client.findUnique({
    where: { id: submission.clientId },
    select: { createdBy: true },
  });
  if (!client?.createdBy) return;

  const ownerUser = await prisma.user.findUnique({
    where: { auth0Sub: client.createdBy },
    select: { id: true },
  });
  if (!ownerUser) return;

  // Source-page lookup is best-effort. If the page was deleted
  // since the form submitted, fall back to "your form".
  let sourcePageTitle = null;
  if (submission.pageId) {
    const page = await prisma.sitePage
      .findUnique({
        where: { id: submission.pageId },
        select: { title: true },
      })
      .catch(() => null);
    sourcePageTitle = page?.title ?? null;
  }
  let formName = null;
  if (submission.formId) {
    const form = await prisma.form
      .findUnique({
        where: { id: submission.formId },
        select: { name: true },
      })
      .catch(() => null);
    formName = form?.name ?? null;
  }

  // Contact preview: prefer the contact's name; fall back to a
  // single channel (email OR phone). The full identity lives in
  // the Inbox conversation — the bell only needs enough to make
  // the link click-worthy.
  const contactPreview =
    contact?.name ||
    contact?.email ||
    contact?.phone ||
    null;

  await enqueueNotification({
    userId: ownerUser.id,
    eventType: "NEW_LEAD",
    payload: {
      clientId: submission.clientId,
      conversationId: conversation.id,
      contactPreview,
      sourcePageTitle,
      formName,
    },
    resourceType: "conversation",
    resourceId: conversation.id,
  });
}

// ── Contact upsert ─────────────────────────────────────────────────────

async function upsertContact({ clientId, email, phone, submission }) {
  // Identity resolution. Contact has TWO unique constraints in
  // this workspace — (clientId, email) AND (clientId, phone) — and
  // a single new submission can collide on either. Older versions
  // P2002'd on the second key; the safe-merge logic below fills in
  // missing identity fields without ever overwriting an existing
  // primary, and preserves any DIFFERENT identity values that
  // arrive on later submissions as alternates in enrichmentJson.
  //
  // FormSubmission.contactEmail / contactPhone keep the exact
  // value the user typed (not normalized) — that lives in
  // sites.service.js. We only normalize for matching + Contact-
  // table writes here.
  const normEmail = normalizeEmailForLookup(email);
  const normPhone = normalizePhoneForLookup(phone);

  // Lookup: email first (more stable identity), then phone.
  let existing = null;
  if (normEmail) {
    existing = await prisma.contact.findUnique({
      where: { clientId_email: { clientId, email: normEmail } },
    });
  }
  if (!existing && normPhone) {
    existing = await prisma.contact.findUnique({
      where: { clientId_phone: { clientId, phone: normPhone } },
    });
  }

  // Inferred name from the dataJson — best-effort. The intake
  // service doesn't try to be smart about this; the Inbox UI
  // shows the email/phone as the headline if no name was given.
  const inferredName = pickField(submission.dataJson, ["name", "fullName", "full_name", "firstName"]);

  // Build the enrichment update. submissions are append-only;
  // alternate identity arrays are deduped against what's already
  // on the existing contact (if any).
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
    // Alternates: if the incoming normalized identity differs from
    // the existing primary, append it to the alternates list so the
    // UI can render "Also submitted with…" without overwriting the
    // primary. Never includes the existing primary itself.
    const existingAlts = readAlternates(existing.enrichmentJson);
    const altEmails = [...existingAlts.emails];
    const altPhones = [...existingAlts.phones];
    const addedAltEmails = [];
    const addedAltPhones = [];
    if (
      normEmail &&
      existing.email &&
      normEmail !== existing.email &&
      !altEmails.includes(normEmail)
    ) {
      altEmails.push(normEmail);
      addedAltEmails.push(normEmail);
    }
    if (
      normPhone &&
      existing.phone &&
      normPhone !== existing.phone &&
      !altPhones.includes(normPhone)
    ) {
      altPhones.push(normPhone);
      addedAltPhones.push(normPhone);
    }
    enrichmentMerge.alternateEmails = altEmails;
    enrichmentMerge.alternatePhones = altPhones;

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
    if (!existing.email && normEmail) {
      const taken = await prisma.contact.findFirst({
        where: { clientId, email: normEmail, id: { not: existing.id } },
        select: { id: true },
      });
      if (!taken) data.email = normEmail;
    }
    // Same check for phone.
    if (!existing.phone && normPhone) {
      const taken = await prisma.contact.findFirst({
        where: { clientId, phone: normPhone, id: { not: existing.id } },
        select: { id: true },
      });
      if (!taken) data.phone = normPhone;
    }
    const updated = await prisma.contact.update({
      where: { id: existing.id },
      data,
    });

    // Audit: emit a row when a brand-new alternate was preserved
    // on the existing contact. Intake runs outside any user session
    // (called from the public form-intake endpoint), so the actor
    // is the system. Skip when no new alternates were added so the
    // audit table doesn't fill with no-op rows on repeat submissions
    // from the same identity.
    if (addedAltEmails.length > 0 || addedAltPhones.length > 0) {
      await writeIntakeAudit({
        clientId,
        contactId: updated.id,
        submissionId: submission.id,
        addedAltEmails,
        addedAltPhones,
      });
    }

    return updated;
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
      email: normEmail,
      phone: normPhone,
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
  // Inbox-level duplicate-content spam rule (spinstr15). If the
  // same contact submits an identical payload within the dup
  // window, route the new conversation to the Spam tab instead
  // of OPEN. We don't delete or skip — preserving the row is
  // important for the audit trail (and the workspace user can
  // unmark if it's a false positive). Idempotency on
  // sourceFormSubmissionId already prevents EXACT duplicates;
  // this catches the bot pattern where the same contact replays
  // the same dataJson with a fresh submission id.
  const isLikelySpam = await detectDuplicateContentSpam({
    clientId,
    contactId: contact.id,
    submission,
  });
  return prisma.conversation.create({
    data: {
      clientId,
      contactId: contact.id,
      sourceType: "FORM",
      sourceFormSubmissionId: submission.id,
      pageId: submission.pageId,
      campaignId: submission.campaignId,
      status: "OPEN",
      spam: isLikelySpam,
      // The form submission IS the first message — stamp the
      // timestamps off submission.createdAt so the inbox sort
      // is consistent with the underlying event.
      lastMessageAt: submission.createdAt,
      lastMessageFrom: "CONTACT",
    },
  });
}

// Returns true when this contact has submitted the same dataJson
// (by stable hash) within the dup window. Bounded lookback (10
// minutes, last 5 conversations) so a real burst of legit forms
// from the same person on the same day doesn't get false-flagged.
const DUP_WINDOW_MS = 10 * 60_000;
async function detectDuplicateContentSpam({ clientId, contactId, submission }) {
  try {
    const payload = submission?.dataJson ?? null;
    if (!payload || typeof payload !== "object") return false;
    const since = new Date(Date.now() - DUP_WINDOW_MS);
    const recent = await prisma.conversation.findMany({
      where: {
        clientId,
        contactId,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        messages: {
          where: { party: "CONTACT", channel: "FORM_SUBMISSION" },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { payloadJson: true },
        },
      },
    });
    const currentHash = stableHashJson(payload);
    for (const c of recent) {
      const m0 = c.messages?.[0];
      if (!m0?.payloadJson) continue;
      if (stableHashJson(m0.payloadJson) === currentHash) {
        return true;
      }
    }
    return false;
  } catch (err) {
    // Best-effort guard — a heuristic failure must never block
    // legitimate intake. Default to NOT spam on error.
    console.warn("[inbox.intake] duplicate-content check failed:", err?.message);
    return false;
  }
}

// Stable JSON serialization for hashing — sorts object keys so
// {a:1,b:2} and {b:2,a:1} hash to the same value.
function stableHashJson(value) {
  return stableStringify(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
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
  // { submissions: [...], alternateEmails: [...], alternatePhones: [...],
  // ...future-tagged-keys }.
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
  const submissions = Array.isArray(base.submissions) ? base.submissions : [];
  const merged = {
    ...base,
    submissions: [...submissions, ...(next.submissions || [])],
  };
  // Alternates: callers compute the FULL list (existing + new),
  // then pass it in next.alternateEmails / next.alternatePhones.
  // We replace (not concat) so duplicates stay deduped.
  if (Array.isArray(next.alternateEmails)) {
    merged.alternateEmails = next.alternateEmails;
  }
  if (Array.isArray(next.alternatePhones)) {
    merged.alternatePhones = next.alternatePhones;
  }
  return merged;
}

// Pull alternate emails/phones off a Contact.enrichmentJson. Both
// arrays are always strings (normalized form). Tolerates missing /
// malformed enrichment shapes.
function readAlternates(enrichmentJson) {
  const empty = { emails: [], phones: [] };
  if (!enrichmentJson || typeof enrichmentJson !== "object") return empty;
  const emails = Array.isArray(enrichmentJson.alternateEmails)
    ? enrichmentJson.alternateEmails.filter((s) => typeof s === "string" && s.length > 0)
    : [];
  const phones = Array.isArray(enrichmentJson.alternatePhones)
    ? enrichmentJson.alternatePhones.filter((s) => typeof s === "string" && s.length > 0)
    : [];
  return { emails, phones };
}

// Best-effort audit row for an intake event that added an alternate
// identity to an existing Contact. Intake has no request context
// (form-intake is a public endpoint, not user-driven), so the actor
// is "system:intake". Never let an audit failure bubble — same
// contract as writeAudit() in lib/auditLog.js.
async function writeIntakeAudit({
  clientId,
  contactId,
  submissionId,
  addedAltEmails,
  addedAltPhones,
}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorSub: "system:intake",
        actorEmail: null,
        actorRoles: ["system"],
        action: "contact.alternate.added",
        resourceType: "Contact",
        resourceId: contactId,
        route: null,
        metadata: {
          clientId,
          submissionId,
          addedAlternateEmails: addedAltEmails,
          addedAlternatePhones: addedAltPhones,
        },
        ip: null,
        userAgent: null,
      },
    });
  } catch (err) {
    console.error("[INBOX_INTAKE] audit_write_failed:", {
      contactId,
      submissionId,
      err: err?.message ?? err,
    });
  }
}

// Normalize an email for matching + Contact-table storage. The raw
// user-typed value is preserved on FormSubmission.contactEmail (set
// in sites.service.js) — never touched here.
function normalizeEmailForLookup(email) {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Normalize a phone for matching + Contact-table storage. Strips
// every non-digit character. Anything less than 7 digits is
// treated as junk and returns null (so a "phone-only" Contact
// isn't created on accidental garbage).
function normalizePhoneForLookup(phone) {
  if (typeof phone !== "string") return null;
  const digits = phone.replace(/\D+/g, "");
  return digits.length >= 7 ? digits : null;
}
