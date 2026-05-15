// Backfill script idempotency.
//
// scripts/backfillInbox.js walks every FormSubmission with a usable
// contact channel and runs intakeFormSubmission. Idempotency lives
// in the intake service (sourceFormSubmissionId is unique on
// Conversation), not in the script — but a re-run must NEVER
// double-create Conversations or fire a second NEW_LEAD bell.
//
// Rather than booting the CLI script (it imports PrismaClient at
// the top level, which would hit the real DB), we exercise the
// same call pattern directly: take a batch of submissions, call
// intakeFormSubmission on each, then re-run.

import { describe, it, expect, vi, beforeEach } from "vitest";

const CLIENT_ID = "client-bf";

let prismaMock;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const enqueueNotificationSpy = vi.fn();
vi.mock("../domains/notifications/notification.service.js", () => ({
  enqueueNotification: (...args) => enqueueNotificationSpy(...args),
}));

const { intakeFormSubmission } = await import(
  "../domains/inbox/inbox.intake.service.js"
);

function createPrismaMock() {
  const state = {
    conversations: new Map(),
    contacts: new Map(),
    messages: [],
    auditLogs: [],
  };
  let convCounter = 0;
  let contactCounter = 0;
  let messageCounter = 0;

  return {
    state,
    conversation: {
      findUnique: vi.fn(async ({ where }) => {
        if (where.sourceFormSubmissionId) {
          for (const c of state.conversations.values()) {
            if (c.sourceFormSubmissionId === where.sourceFormSubmissionId) return c;
          }
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
        const k = where.clientId_email ?? where.clientId_phone;
        if (!k) return null;
        for (const c of state.contacts.values()) {
          if (c.clientId !== k.clientId) continue;
          if (where.clientId_email && c.email === k.email) return c;
          if (where.clientId_phone && c.phone === k.phone) return c;
        }
        return null;
      }),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => {
        const id = `contact-${++contactCounter}`;
        const row = { id, ...data };
        state.contacts.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.contacts.get(where.id);
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
    auditLog: { create: vi.fn(async () => null) },
    client: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => null) },
    sitePage: { findUnique: vi.fn(async () => null) },
    form: { findUnique: vi.fn(async () => null) },
  };
}

function makeSubmission(i) {
  return {
    id: `sub-${i}`,
    clientId: CLIENT_ID,
    formId: "form-1",
    pageId: "page-1",
    campaignId: null,
    contactEmail: `lead${i}@example.com`,
    contactPhone: null,
    dataJson: { email: `lead${i}@example.com`, name: `Lead ${i}` },
    createdAt: new Date(`2026-05-${10 + (i % 5)}T10:00:00Z`),
  };
}

// Exercise the same per-submission loop the script runs.
async function runBackfillBatch(submissions) {
  const totals = { created: 0, alreadyProcessed: 0, skipped: 0 };
  for (const sub of submissions) {
    const r = await intakeFormSubmission(sub);
    if (r.status === "created") totals.created += 1;
    else if (r.status === "already_processed") totals.alreadyProcessed += 1;
    else if (r.status === "skipped") totals.skipped += 1;
  }
  return totals;
}

const flush = () => new Promise((r) => setImmediate(r));

describe("backfill — idempotency contract", () => {
  beforeEach(() => {
    prismaMock = createPrismaMock();
    enqueueNotificationSpy.mockClear();
  });

  it("first run creates conversations; second run reports already_processed for every row", async () => {
    const submissions = [makeSubmission(1), makeSubmission(2), makeSubmission(3)];

    const first = await runBackfillBatch(submissions);
    await flush();
    expect(first).toEqual({ created: 3, alreadyProcessed: 0, skipped: 0 });
    expect(prismaMock.state.conversations.size).toBe(3);

    const second = await runBackfillBatch(submissions);
    await flush();
    expect(second).toEqual({ created: 0, alreadyProcessed: 3, skipped: 0 });
    // Conversation count is stable — no duplicates created.
    expect(prismaMock.state.conversations.size).toBe(3);
    // Contact count is stable too.
    expect(prismaMock.state.contacts.size).toBe(3);
    // Initial messages — exactly one per conversation, never doubled.
    expect(prismaMock.state.messages.length).toBe(3);
  });

  it("no NEW_LEAD bells fire on the second backfill pass", async () => {
    const submissions = [makeSubmission(10), makeSubmission(11)];
    await runBackfillBatch(submissions);
    await flush();
    enqueueNotificationSpy.mockClear();

    await runBackfillBatch(submissions);
    await flush();
    // Replay should be silent — every submission short-circuits at
    // the sourceFormSubmissionId idempotency check, well before
    // the notify path is reached.
    expect(enqueueNotificationSpy).not.toHaveBeenCalled();
  });

  it("skips submissions with no usable identity (no infinite-retry loop)", async () => {
    const submissions = [
      makeSubmission(20),
      { ...makeSubmission(21), contactEmail: null, contactPhone: null },
    ];
    const result = await runBackfillBatch(submissions);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("re-running after a partial batch (some rows succeeded) only intakes the remainder", async () => {
    const all = [makeSubmission(30), makeSubmission(31), makeSubmission(32)];
    // Simulate a partial run by intaking just the first row.
    await intakeFormSubmission(all[0]);
    await flush();
    expect(prismaMock.state.conversations.size).toBe(1);

    // Now run the full batch — the first row should report
    // already_processed and the other two should report created.
    const totals = await runBackfillBatch(all);
    await flush();
    expect(totals.alreadyProcessed).toBe(1);
    expect(totals.created).toBe(2);
    expect(prismaMock.state.conversations.size).toBe(3);
  });
});
