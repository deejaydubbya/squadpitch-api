import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ clientFindFirst: vi.fn(), feedbackFindUnique: vi.fn(), feedbackCreate: vi.fn(), feedbackFindMany: vi.fn(), feedbackUpdate: vi.fn() }));
vi.mock("../prisma.js", () => ({ prisma: { client: { findFirst: mocks.clientFindFirst }, betaFeedback: { findUnique: mocks.feedbackFindUnique, create: mocks.feedbackCreate, findMany: mocks.feedbackFindMany, update: mocks.feedbackUpdate } } }));
const { listOwnFeedback, submitFeedback, updateAdminFeedback } = await import("../domains/feedback/feedback.service.js");

describe("feedback persistence boundaries", () => {
  beforeEach(() => vi.clearAllMocks());
  it("stores authenticated identity, workspace snapshots, safe context, defaults, and idempotency", async () => {
    mocks.clientFindFirst.mockResolvedValue({ id: "client-1", name: "Acme Realty" });
    mocks.feedbackFindUnique.mockResolvedValue(null);
    mocks.feedbackCreate.mockImplementation(({ data }) => ({ id: "feedback-1", createdAt: new Date(), ...data }));
    const input = { type: "bug", message: "Exact browser message", clientId: "client-1", route: "/workspaces/client-1", releaseVersion: "sha-1", deviceClass: "mobile", viewport: { width: 390, height: 844 }, idempotencyKey: "key-1" };
    const result = await submitFeedback({ input, user: { id: "user-1", email: "person@example.com", name: "Person" }, auth0Sub: "auth0|person" });
    expect(mocks.clientFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "client-1", createdBy: "auth0|person" } }));
    expect(mocks.feedbackCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", submitterEmail: "person@example.com", submitterName: "Person", workspaceId: "client-1", workspaceName: "Acme Realty", type: "bug", body: "Exact browser message", route: "/workspaces/client-1", status: "new", severity: "normal", releaseVersion: "sha-1", deviceClass: "mobile", idempotencyKey: "key-1", metadata: { viewport: { width: 390, height: 844 } } }) });
    expect(result.duplicate).toBe(false);
  });
  it("returns the original record for a repeated key without creating twice", async () => {
    mocks.feedbackFindUnique.mockResolvedValue({ id: "feedback-1", userId: "user-1" });
    const result = await submitFeedback({ input: { idempotencyKey: "same" }, user: { id: "user-1" }, auth0Sub: "auth0|person" });
    expect(result.duplicate).toBe(true);
    expect(mocks.feedbackCreate).not.toHaveBeenCalled();
  });
  it("scopes history to the authenticated user", async () => {
    mocks.feedbackFindMany.mockResolvedValue([]);
    await listOwnFeedback("user-1");
    expect(mocks.feedbackFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1" } }));
  });
  it("persists admin priority, note, status, resolver, and resolved timestamp", async () => {
    mocks.feedbackUpdate.mockImplementation(({ data }) => data);
    const result = await updateAdminFeedback("feedback-1", { status: "resolved", priority: "high", adminNote: "Verified" }, "admin-1");
    expect(result).toEqual(expect.objectContaining({ status: "resolved", severity: "high", internalNotes: "Verified", resolvedBy: "admin-1", resolvedAt: expect.any(Date) }));
  });
});
