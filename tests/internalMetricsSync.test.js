// Tests for POST /api/v1/internal/drafts/:draftId/metrics/sync
//
// Covers role gating, prereq validation, response shape stability,
// the force=true cooldown bypass, and the no-token-leak invariant.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// In-memory draft store the mock prisma reads from. Each test seeds it.
const drafts = new Map();
const syncResults = new Map(); // draftId → result object the sync stub returns
const syncCalls = []; // captured (draftId, options) so we can assert force flag

vi.mock("../prisma.js", () => ({
  prisma: {
    draft: {
      findUnique: vi.fn(async ({ where }) => drafts.get(where.id) ?? null),
    },
  },
}));

// Stub every other internal-service module the router pulls in.
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
}));
vi.mock("../domains/internal/externalServices.service.js", () => ({}));
vi.mock("../domains/internal/betaOps.service.js", () => ({}));
vi.mock("../domains/internal/jobs.service.js", () => ({}));
vi.mock("../domains/internal/webhooks.service.js", () => ({}));
vi.mock("../domains/internal/systemHealth.service.js", () => ({}));
vi.mock("../domains/internal/config.service.js", () => ({}));

// The metrics service — controlled per-test.
vi.mock("../domains/studio/metricsSyncService.js", () => ({
  syncMetricsForDraft: vi.fn(async (draftId, options) => {
    syncCalls.push({ draftId, options });
    if (syncResults.has(draftId)) {
      const r = syncResults.get(draftId);
      if (r instanceof Error) throw r;
      return r;
    }
    return { synced: false, reason: "draft_not_found" };
  }),
}));

vi.mock("../lib/logger.js", () => ({
  logEvent: vi.fn(),
}));

// Two role-gating modes:
// - default: requireInternalAccess admits anyone (router-level guard already
//   passed). Tests inject roles via x-test-roles to model "real" behavior.
// - The role middleware below mirrors production: blocks non-admin/developer.
vi.mock("../middleware/requireRole.js", () => {
  const requireInternalAccess = (req, res, next) => {
    const header = req.headers["x-test-roles"];
    const roles = header ? String(header).split(",") : [];
    req.roles = roles;
    if (!roles.includes("admin") && !roles.includes("developer")) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }
    return next();
  };
  return {
    requireInternalAccess,
    requireAdminRole: (req, res, next) => {
      if (!req.roles?.includes("admin")) return res.status(403).json({ error: "FORBIDDEN" });
      return next();
    },
  };
});

const { internalRouter } = await import("../domains/internal/internal.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  // Stash an actor sub on req.auth.payload so logEvent can pick it up.
  app.use((req, _res, next) => {
    req.auth = { payload: { sub: req.headers["x-test-sub"] ?? "auth0|admin1" } };
    next();
  });
  app.use(internalRouter);
  return app;
}

beforeEach(() => {
  drafts.clear();
  syncResults.clear();
  syncCalls.length = 0;
  vi.clearAllMocks();
});

const URL = (id) => `/api/v1/internal/drafts/${id}/metrics/sync`;
const SECRET = "supersecret-bearer-xyz123";

describe("POST /internal/drafts/:id/metrics/sync — role gating", () => {
  it("normal user (no roles) is blocked with 403 — no draft lookup, no sync", async () => {
    drafts.set("d1", { id: "d1", clientId: "c1", channel: "INSTAGRAM", status: "PUBLISHED", externalPostId: "ig-1" });
    const app = buildApp();
    const res = await request(app).post(URL("d1")).send({ force: true });
    expect(res.status).toBe(403);
    // Confirm the sync service was never invoked.
    expect(syncCalls.length).toBe(0);
  });

  it("developer role is admitted", async () => {
    drafts.set("d1", { id: "d1", clientId: "c1", channel: "INSTAGRAM", status: "PUBLISHED", externalPostId: "ig-1" });
    syncResults.set("d1", {
      synced: true,
      metrics: {},
      rawMetricId: "raw-1",
      normalizedMetricId: "norm-1",
      fetchedAt: "2026-05-08T00:00:00Z",
    });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("admin role is admitted", async () => {
    drafts.set("d1", { id: "d1", clientId: "c1", channel: "INSTAGRAM", status: "PUBLISHED", externalPostId: "ig-1" });
    syncResults.set("d1", { synced: true, metrics: {}, rawMetricId: "raw-1", normalizedMetricId: "norm-1", fetchedAt: "2026-05-08T00:00:00Z" });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "admin")
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("POST /internal/drafts/:id/metrics/sync — prerequisite validation", () => {
  it("missing draft → 404 DRAFT_NOT_FOUND", async () => {
    const app = buildApp();
    const res = await request(app)
      .post(URL("missing"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("DRAFT_NOT_FOUND");
  });

  it("non-PUBLISHED draft → 422 NOT_PUBLISHED, sync not invoked", async () => {
    drafts.set("d1", { id: "d1", clientId: "c1", channel: "X", status: "DRAFT", externalPostId: null });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("NOT_PUBLISHED");
    expect(syncCalls.length).toBe(0);
  });

  it("missing externalPostId → 200 with status=skipped reason=no_external_id, sync not invoked", async () => {
    drafts.set("d1", { id: "d1", clientId: "c1", channel: "INSTAGRAM", status: "PUBLISHED", externalPostId: null });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      status: "skipped",
      reason: "no_external_id",
      externalPostId: null,
      postMetricsUpdated: false,
    });
    expect(syncCalls.length).toBe(0);
  });
});

describe("POST /internal/drafts/:id/metrics/sync — successful sync", () => {
  beforeEach(() => {
    drafts.set("d1", { id: "d1", clientId: "c1", channel: "INSTAGRAM", status: "PUBLISHED", externalPostId: "ig-1" });
  });

  it("returns the debug-safe success shape", async () => {
    syncResults.set("d1", {
      synced: true,
      metrics: { impressions: 1000 },
      rawMetricId: "raw-1",
      normalizedMetricId: "norm-1",
      fetchedAt: "2026-05-08T00:00:00Z",
    });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      draftId: "d1",
      clientId: "c1",
      channel: "INSTAGRAM",
      externalPostId: "ig-1",
      status: "synced",
      reason: null,
      detail: null,
      rawMetricId: "raw-1",
      normalizedMetricId: "norm-1",
      postMetricsUpdated: true,
      lastSyncedAt: "2026-05-08T00:00:00Z",
      forceUsed: true,
    });
    // durationMs is present and non-negative.
    expect(typeof res.body.durationMs).toBe("number");
    expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("force=true is propagated to the sync service", async () => {
    syncResults.set("d1", { synced: true, metrics: {}, rawMetricId: "r", normalizedMetricId: "n", fetchedAt: null });
    const app = buildApp();
    await request(app).post(URL("d1")).set("x-test-roles", "admin").send({ force: true });
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]).toEqual({ draftId: "d1", options: { force: true } });
  });

  it("force=false (or omitted) is also propagated — defaults to false", async () => {
    syncResults.set("d1", { synced: true, metrics: {}, rawMetricId: "r", normalizedMetricId: "n", fetchedAt: null });
    const app = buildApp();
    await request(app).post(URL("d1")).set("x-test-roles", "admin").send({});
    expect(syncCalls[0].options).toEqual({ force: false });
  });
});

describe("POST /internal/drafts/:id/metrics/sync — sync failures and skips", () => {
  beforeEach(() => {
    drafts.set("d1", { id: "d1", clientId: "c1", channel: "TIKTOK", status: "PUBLISHED", externalPostId: "v_pub_url~v2-1.123" });
  });

  it("provider failures classify as status=failed", async () => {
    syncResults.set("d1", { synced: false, reason: "tiktok_video_id_missing" });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      status: "failed",
      reason: "tiktok_video_id_missing",
      postMetricsUpdated: false,
    });
  });

  it("cooldown reason classifies as status=skipped", async () => {
    syncResults.set("d1", { synced: false, reason: "too_recent" });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: false });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("skipped");
    expect(res.body.reason).toBe("too_recent");
  });

  it("token_refresh_failed exposes a short safe detail string", async () => {
    syncResults.set("d1", {
      synced: false,
      reason: "token_refresh_failed",
      detail: "REFRESH_REVOKED",
    });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("token_refresh_failed");
    expect(res.body.detail).toBe("REFRESH_REVOKED");
  });

  it("if a Bearer-style header sneaks into detail, the route masks it", async () => {
    // Defense-in-depth: even though the service contract forbids tokens
    // in detail, the route layer scrubs Bearer patterns before emitting.
    syncResults.set("d1", {
      synced: false,
      reason: "token_refresh_failed",
      detail: `upstream refused with header: Bearer ${SECRET}`,
    });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.detail).toMatch(/Bearer \*\*\*/);
  });

  it("very long detail strings get truncated to keep debug output sane", async () => {
    syncResults.set("d1", {
      synced: false,
      reason: "provider_transient",
      detail: "x".repeat(2000),
    });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.body.detail.length).toBeLessThanOrEqual(500);
    expect(res.body.detail.endsWith("...")).toBe(true);
  });

  it("unclassified service throw is caught and returned as status=failed reason=internal_error", async () => {
    syncResults.set("d1", new Error("kaboom"));
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "developer")
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      status: "failed",
      reason: "internal_error",
    });
  });
});

describe("POST /internal/drafts/:id/metrics/sync — response surface invariants", () => {
  it("never includes an Authorization header echo or token-shaped string", async () => {
    drafts.set("d1", { id: "d1", clientId: "c1", channel: "INSTAGRAM", status: "PUBLISHED", externalPostId: "ig-1" });
    syncResults.set("d1", { synced: true, metrics: { impressions: 1 }, rawMetricId: "r", normalizedMetricId: "n", fetchedAt: null });
    const app = buildApp();
    const res = await request(app)
      .post(URL("d1"))
      .set("x-test-roles", "admin")
      .set("authorization", `Bearer ${SECRET}`)
      .send({ force: true });
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("Bearer");
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("accessToken");
    expect(body).not.toContain("refreshToken");
  });
});
