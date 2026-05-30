// Sites-06 — public form submit tenant scoping.
//
// The public POST /api/v1/public/forms/:formId/submit endpoint
// accepts pageId + campaignId from the page renderer. We don't
// trust the renderer to be honest about cross-tenant ids — a
// crafted submission from a different workspace's page must not
// land an unrelated pageId on the FormSubmission row.
//
// createFormSubmission silently strips ids that don't belong to
// form.clientId. Test pins this contract.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
let createCalls;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

vi.mock("../domains/inbox/inboxIntake.service.js", () => ({
  intakeFormSubmission: vi.fn(async () => undefined),
}));

const { createFormSubmission } = await import("../domains/sites/sites.service.js");

function buildPrisma({
  pageBelongsToClient = false,
  campaignBelongsToClient = false,
} = {}) {
  createCalls = [];
  prismaMock = {
    sitePage: {
      findFirst: vi.fn(async ({ where }) => {
        // Sites-06 contract: only return a row if the requested
        // pageId belongs to the workspace's clientId.
        if (pageBelongsToClient) return { id: where.id };
        return null;
      }),
    },
    campaign: {
      findFirst: vi.fn(async ({ where }) => {
        if (campaignBelongsToClient) return { id: where.id };
        return null;
      }),
    },
    formSubmission: {
      create: vi.fn(async ({ data }) => {
        createCalls.push(data);
        return {
          id: `sub-${createCalls.length}`,
          ...data,
        };
      }),
    },
  };
}

function form() {
  return {
    id: "form-1",
    clientId: "client-A",
    fieldsJson: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "email", label: "Email", type: "email", required: true },
    ],
    successAction: { type: "message", message: "Thanks" },
  };
}

beforeEach(() => {
  buildPrisma();
});

describe("createFormSubmission — tenant-scoped pageId / campaignId", () => {
  it("persists pageId when it belongs to the form's clientId", async () => {
    buildPrisma({ pageBelongsToClient: true });
    await createFormSubmission({
      form: form(),
      fields: { name: "Bart", email: "x@y.com" },
      pageId: "page-A-1",
    });
    expect(createCalls[0].pageId).toBe("page-A-1");
  });

  it("strips pageId to null when the page belongs to a different workspace", async () => {
    buildPrisma({ pageBelongsToClient: false });
    await createFormSubmission({
      form: form(),
      fields: { name: "Bart", email: "x@y.com" },
      pageId: "page-from-other-workspace",
    });
    expect(createCalls[0].pageId).toBeNull();
  });

  it("persists campaignId when it belongs to the form's clientId", async () => {
    buildPrisma({ campaignBelongsToClient: true });
    await createFormSubmission({
      form: form(),
      fields: { name: "Bart", email: "x@y.com" },
      campaignId: "camp-A-1",
    });
    expect(createCalls[0].campaignId).toBe("camp-A-1");
  });

  it("strips campaignId to null when the campaign belongs to a different workspace", async () => {
    buildPrisma({ campaignBelongsToClient: false });
    await createFormSubmission({
      form: form(),
      fields: { name: "Bart", email: "x@y.com" },
      campaignId: "camp-from-other-workspace",
    });
    expect(createCalls[0].campaignId).toBeNull();
  });

  it("writes nulls when pageId / campaignId are missing entirely", async () => {
    buildPrisma();
    await createFormSubmission({
      form: form(),
      fields: { name: "Bart", email: "x@y.com" },
    });
    expect(createCalls[0].pageId).toBeNull();
    expect(createCalls[0].campaignId).toBeNull();
  });

  it("strips non-string pageId values (defensive)", async () => {
    buildPrisma({ pageBelongsToClient: true });
    await createFormSubmission({
      form: form(),
      fields: { name: "Bart", email: "x@y.com" },
      pageId: 123,
    });
    expect(createCalls[0].pageId).toBeNull();
  });

  it("extracts contactEmail + contactPhone from submitted fields", async () => {
    buildPrisma();
    await createFormSubmission({
      form: {
        ...form(),
        fieldsJson: [
          { key: "email", label: "Email", type: "email" },
          { key: "phone", label: "Phone", type: "phone" },
        ],
      },
      fields: { email: "x@y.com", phone: "+15555550100" },
    });
    expect(createCalls[0].contactEmail).toBe("x@y.com");
    expect(createCalls[0].contactPhone).toBe("+15555550100");
  });

  it("truncates excessive userAgent / referer strings", async () => {
    buildPrisma();
    const long = "X".repeat(800);
    await createFormSubmission({
      form: form(),
      fields: { email: "x@y.com" },
      userAgent: long,
      referer: long,
    });
    expect(createCalls[0].userAgent).toHaveLength(500);
    expect(createCalls[0].referer).toHaveLength(500);
  });
});
