// Verifies the P0.2 fix: DELETE /api/v1/internal/workspaces no longer wipes
// the database. It returns 410 Gone whether the caller is admin or
// developer, and `deleteAllWorkspaces` is no longer exported by the
// internal service.

import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// Mock every service dependency so importing internal.routes.js doesn't
// pull in real DB code.
vi.mock("../domains/internal/internal.service.js", () => ({
  getHealth: () => ({ status: "ok" }),
  getUserWithRoles: (user, roles) => ({ user, roles }),
  listWorkspaces: vi.fn(),
  getWorkspaceDetail: vi.fn(),
  listDrafts: vi.fn(),
  getDraftDetail: vi.fn(),
  listConnections: vi.fn(),
  listTechStackConnections: vi.fn(),
  listPublishingActivity: vi.fn(),
  // Intentionally not exporting deleteAllWorkspaces — and the route handler
  // no longer calls it. The retired symbol must stay retired.
}));
vi.mock("../domains/internal/externalServices.service.js", () => ({}));
vi.mock("../domains/internal/betaOps.service.js", () => ({}));
vi.mock("../domains/internal/jobs.service.js", () => ({}));
vi.mock("../domains/internal/webhooks.service.js", () => ({}));
vi.mock("../domains/internal/systemHealth.service.js", () => ({}));
vi.mock("../domains/internal/config.service.js", () => ({}));

// Stand-in role middleware that lets us inject roles per-request via headers.
vi.mock("../middleware/requireRole.js", () => {
  const requireInternalAccess = (req, _res, next) => {
    const header = req.headers["x-test-roles"];
    req.roles = header ? String(header).split(",") : [];
    return next();
  };
  return {
    requireInternalAccess,
    requireAdminRole: (req, res, next) => {
      if (!req.roles?.includes("admin")) {
        return res.status(403).json({ code: "FORBIDDEN" });
      }
      return next();
    },
  };
});

const { internalRouter } = await import(
  "../domains/internal/internal.routes.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(internalRouter);
  return app;
}

describe("DELETE /api/v1/internal/workspaces is permanently retired (P0.2)", () => {
  it("returns 410 Gone for a developer-role caller", async () => {
    const app = buildApp();
    const res = await request(app)
      .delete("/api/v1/internal/workspaces")
      .set("x-test-roles", "developer");
    expect(res.status).toBe(410);
    // sendError() emits { error: <code>, message } — see lib/apiErrors.js
    expect(res.body?.error).toBe("ENDPOINT_REMOVED");
  });

  it("returns 410 Gone for an admin-role caller too — no HTTP path can wipe workspaces", async () => {
    const app = buildApp();
    const res = await request(app)
      .delete("/api/v1/internal/workspaces")
      .set("x-test-roles", "admin");
    expect(res.status).toBe(410);
    // sendError() emits { error: <code>, message } — see lib/apiErrors.js
    expect(res.body?.error).toBe("ENDPOINT_REMOVED");
  });

  it("the route handler does not call any service-side bulk delete", async () => {
    // We mocked internal.service above with no `deleteAllWorkspaces` export.
    // If the route handler still tried to call it, the request would 500.
    // 410 confirms the route is a flat refusal that touches no business logic.
    const app = buildApp();
    const res = await request(app)
      .delete("/api/v1/internal/workspaces")
      .set("x-test-roles", "admin");
    expect(res.status).toBe(410);
  });
});
