// Spinstr427 — submissions list pageId filter + source-context
// enrichment + form stats endpoint.
//
// Pins:
//   - listSubmissions accepts pageId; combines with formId.
//   - clientId on the WHERE tenant-scopes the result so a
//     cross-workspace pageId silently returns empty (not an error).
//   - Response rows include sourceContext { pageId, pageTitle,
//     pageSlug, sourceType, sourceId, sourceTitle } resolved
//     through the page join.
//   - getFormStats counts + last-submission-date; returns null on
//     unknown / cross-workspace formId.
//   - Optional pageId narrows stats to a single page.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { listSubmissions, getFormStats } = await import(
  "../domains/sites/sites.dashboard.service.js"
);

function setupSubmissions({
  rows,
  pages = [],
  conversations = [],
  properties = [],
} = {}) {
  prismaMock = {
    formSubmission: {
      findMany: vi.fn(async () => rows),
      count: vi.fn(),
      findFirst: vi.fn(),
    },
    conversation: {
      findMany: vi.fn(async () => conversations),
    },
    sitePage: {
      findMany: vi.fn(async ({ where }) => {
        // tenant-scope mock — only return pages whose clientId matches
        return pages.filter(
          (p) => p.clientId === where.clientId && where.id.in.includes(p.id),
        );
      }),
    },
    workspaceDataItem: {
      findMany: vi.fn(async ({ where }) =>
        properties.filter(
          (p) => p.clientId === where.clientId && where.id.in.includes(p.id),
        ),
      ),
    },
    leadForm: {
      findFirst: vi.fn(),
    },
  };
}

beforeEach(() => {
  prismaMock = null;
});

describe("listSubmissions — pageId filter + source enrichment", () => {
  it("accepts pageId on the WHERE", async () => {
    setupSubmissions({ rows: [] });
    await listSubmissions("c1", { pageId: "page-1", limit: 10 });
    const call = prismaMock.formSubmission.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ clientId: "c1", pageId: "page-1" });
  });

  it("combines pageId + formId + status", async () => {
    setupSubmissions({ rows: [] });
    await listSubmissions("c1", {
      pageId: "page-1",
      formId: "form-1",
      status: "NEW",
      limit: 10,
    });
    const call = prismaMock.formSubmission.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      clientId: "c1",
      pageId: "page-1",
      formId: "form-1",
      status: "NEW",
    });
  });

  it("returns empty result for cross-workspace pageId (silently)", async () => {
    // The clientId scope on the WHERE means findMany returns []
    // even if the pageId exists in another workspace.
    setupSubmissions({ rows: [] });
    const result = await listSubmissions("c1", {
      pageId: "page-from-other-workspace",
      limit: 10,
    });
    expect(result.submissions).toEqual([]);
  });

  it("enriches each submission with page + source summary", async () => {
    setupSubmissions({
      rows: [
        {
          id: "sub-1",
          formId: "form-1",
          campaignId: null,
          pageId: "page-1",
          dataJson: {},
          contactEmail: "x@y.com",
          contactPhone: null,
          status: "NEW",
          createdAt: new Date("2026-05-18T12:00:00Z"),
          form: { id: "form-1", name: "Contact form" },
        },
      ],
      pages: [
        {
          id: "page-1",
          clientId: "c1",
          title: "508 King George Court",
          slug: "508-king-george-court",
          sourceType: "PROPERTY",
          sourceId: "prop-1",
        },
      ],
      properties: [
        { id: "prop-1", clientId: "c1", title: "508 King George Court (DB)" },
      ],
    });
    const result = await listSubmissions("c1", { limit: 10 });
    expect(result.submissions).toHaveLength(1);
    expect(result.submissions[0].sourceContext).toEqual({
      pageId: "page-1",
      pageTitle: "508 King George Court",
      pageSlug: "508-king-george-court",
      sourceType: "PROPERTY",
      sourceId: "prop-1",
      sourceTitle: "508 King George Court (DB)",
    });
  });

  it("emits sourceContext=null when submission has no pageId", async () => {
    setupSubmissions({
      rows: [
        {
          id: "sub-1",
          formId: "form-1",
          campaignId: null,
          pageId: null,
          dataJson: {},
          contactEmail: "x@y.com",
          contactPhone: null,
          status: "NEW",
          createdAt: new Date(),
          form: { id: "form-1", name: "X" },
        },
      ],
    });
    const result = await listSubmissions("c1", { limit: 10 });
    expect(result.submissions[0].sourceContext).toBeNull();
  });

  it("emits sourceTitle=null for non-PROPERTY sourceTypes", async () => {
    setupSubmissions({
      rows: [
        {
          id: "sub-1",
          formId: "form-1",
          campaignId: null,
          pageId: "page-1",
          dataJson: {},
          contactEmail: null,
          contactPhone: null,
          status: "NEW",
          createdAt: new Date(),
          form: { id: "form-1", name: "X" },
        },
      ],
      pages: [
        {
          id: "page-1",
          clientId: "c1",
          title: "Idea page",
          slug: "idea",
          sourceType: "IDEA",
          sourceId: null,
        },
      ],
    });
    const result = await listSubmissions("c1", { limit: 10 });
    expect(result.submissions[0].sourceContext).toEqual({
      pageId: "page-1",
      pageTitle: "Idea page",
      pageSlug: "idea",
      sourceType: "IDEA",
      sourceId: null,
      sourceTitle: null,
    });
  });
});

describe("getFormStats", () => {
  function setupStats({ form, count = 0, lastAt = null } = {}) {
    prismaMock = {
      leadForm: {
        findFirst: vi.fn(async ({ where }) =>
          form && where.clientId === form.clientId && where.id === form.id
            ? { id: form.id }
            : null,
        ),
      },
      formSubmission: {
        count: vi.fn(async () => count),
        findFirst: vi.fn(async () => (lastAt ? { createdAt: lastAt } : null)),
      },
    };
  }

  it("returns count + last submission date", async () => {
    setupStats({
      form: { id: "form-1", clientId: "c1" },
      count: 7,
      lastAt: new Date("2026-05-18T12:00:00Z"),
    });
    const stats = await getFormStats("c1", "form-1");
    expect(stats).toEqual({
      formId: "form-1",
      pageId: null,
      count: 7,
      lastSubmissionAt: new Date("2026-05-18T12:00:00Z"),
    });
  });

  it("returns null for cross-workspace formId", async () => {
    setupStats({ form: { id: "form-1", clientId: "other-ws" }, count: 99 });
    const stats = await getFormStats("c1", "form-1");
    expect(stats).toBeNull();
  });

  it("returns count=0 + lastSubmissionAt=null for forms with no submissions", async () => {
    setupStats({ form: { id: "form-1", clientId: "c1" }, count: 0, lastAt: null });
    const stats = await getFormStats("c1", "form-1");
    expect(stats.count).toBe(0);
    expect(stats.lastSubmissionAt).toBeNull();
  });

  it("narrows count + lastSubmissionAt to a pageId when provided", async () => {
    setupStats({ form: { id: "form-1", clientId: "c1" }, count: 3, lastAt: new Date() });
    await getFormStats("c1", "form-1", { pageId: "page-1" });
    const countCall = prismaMock.formSubmission.count.mock.calls[0][0];
    const findFirstCall = prismaMock.formSubmission.findFirst.mock.calls[0][0];
    expect(countCall.where).toMatchObject({ clientId: "c1", formId: "form-1", pageId: "page-1" });
    expect(findFirstCall.where).toMatchObject({ clientId: "c1", formId: "form-1", pageId: "page-1" });
  });
});
