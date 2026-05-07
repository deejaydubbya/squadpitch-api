// Audit-log writer tests.
//   - writes the row when a request triggers a mutation
//   - never throws, even if Prisma blows up
//   - redacts known sensitive keys from metadata

import { describe, it, expect, vi, beforeEach } from "vitest";

const auditCreateMock = vi.fn().mockResolvedValue({});
vi.mock("../prisma.js", () => ({
  prisma: { auditLog: { create: auditCreateMock } },
}));

const { writeAudit, _internal } = await import("../lib/auditLog.js");

function makeReq(overrides = {}) {
  return {
    method: "PATCH",
    originalUrl: "/api/v1/internal/config/flags/abc",
    auth: { payload: { sub: "auth0|alice" } },
    user: { email: "alice@example.com" },
    roles: ["admin"],
    ip: "10.0.0.1",
    get: () => "Mozilla/5.0",
    log: { error: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  auditCreateMock.mockReset().mockResolvedValue({});
});

describe("writeAudit", () => {
  it("writes a row with the actor + action context", async () => {
    await writeAudit(makeReq(), {
      action: "flag.toggle",
      resourceType: "FeatureFlag",
      resourceId: "flag-1",
      metadata: { from: false, to: true },
    });
    expect(auditCreateMock).toHaveBeenCalledTimes(1);
    const data = auditCreateMock.mock.calls[0][0].data;
    expect(data).toMatchObject({
      actorSub: "auth0|alice",
      actorEmail: "alice@example.com",
      actorRoles: ["admin"],
      action: "flag.toggle",
      resourceType: "FeatureFlag",
      resourceId: "flag-1",
      route: "PATCH /api/v1/internal/config/flags/abc",
    });
    expect(data.metadata).toEqual({ from: false, to: true });
  });

  it("redacts sensitive keys in metadata", async () => {
    await writeAudit(makeReq(), {
      action: "service.update",
      resourceType: "ExternalService",
      resourceId: "svc-1",
      metadata: {
        accessToken: "tok_real",
        secret: "shh",
        nested: { apiKey: "sk-abc", safe: "ok" },
      },
    });
    const data = auditCreateMock.mock.calls[0][0].data;
    expect(data.metadata).toEqual({
      accessToken: "[REDACTED]",
      secret: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "ok" },
    });
  });

  it("never throws when Prisma fails", async () => {
    auditCreateMock.mockRejectedValue(new Error("db down"));
    const req = makeReq();
    await expect(
      writeAudit(req, {
        action: "flag.delete",
        resourceType: "FeatureFlag",
        resourceId: "flag-1",
      })
    ).resolves.toBeUndefined();
    // The error was logged via the request logger so ops can grep for it.
    expect(req.log.error).toHaveBeenCalled();
  });

  it("ignores incomplete entries (no action / resourceType)", async () => {
    await writeAudit(makeReq(), { action: "flag.toggle" });
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("redact() truncates pathological recursion", () => {
    const root = { a: 1 };
    const child = { name: "deep" };
    let cur = root;
    for (let i = 0; i < 10; i++) {
      cur.next = { idx: i };
      cur = cur.next;
    }
    cur.bottom = child;
    const out = _internal.redact(root);
    // Implementation truncates at depth 6 — find a `[TRUNCATED]` marker
    // somewhere down the chain.
    const stringified = JSON.stringify(out);
    expect(stringified).toContain("[TRUNCATED]");
  });
});
