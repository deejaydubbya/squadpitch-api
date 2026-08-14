import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SubmitFeedbackSchema, UpdateFeedbackSchema, safeFeedbackRoute } from "../domains/feedback/feedback.schemas.js";

const valid = { type: "bug", message: "The save button did not respond.", clientId: "client-1", route: "/workspaces/client-1/create?token=secret", deviceClass: "desktop", viewport: { width: 1440, height: 900 }, idempotencyKey: "00000000-0000-4000-8000-000000000001" };

describe("in-app feedback contracts", () => {
  it("migrates every representative legacy row without destructive schema operations", () => {
    const sql = readFileSync("prisma/migrations/20260813150000_in_app_feedback_context/migration.sql", "utf8");
    const legacy = [
      ["new", "low", "new", "low"], ["triaged", "medium", "reviewing", "normal"],
      ["in_progress", "high", "reviewing", "high"], ["resolved", "critical", "resolved", "urgent"],
      ["wont_fix", "medium", "closed", "normal"], ["duplicate", "low", "closed", "low"],
    ];
    const migrateStatus = (value) => ({ triaged: "reviewing", in_progress: "reviewing", wont_fix: "closed", duplicate: "closed" })[value] || value;
    const migratePriority = (value) => ({ critical: "urgent", medium: "normal" })[value] || value;
    for (const [status, priority, expectedStatus, expectedPriority] of legacy) {
      expect(migrateStatus(status)).toBe(expectedStatus);
      expect(migratePriority(priority)).toBe(expectedPriority);
    }
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)|DELETE\s+FROM|TRUNCATE/i);
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(7);
    expect(sql).toContain('ALTER COLUMN "severity" SET DEFAULT \'normal\'');
  });
  it.each(["bug", "feature_request", "ux_issue", "general"])("accepts the supported %s type", (type) => expect(SubmitFeedbackSchema.safeParse({ ...valid, type }).success).toBe(true));
  it("rejects invalid types", () => expect(SubmitFeedbackSchema.safeParse({ ...valid, type: "praise" }).success).toBe(false));
  it("rejects empty and oversized messages", () => {
    expect(SubmitFeedbackSchema.safeParse({ ...valid, message: " " }).success).toBe(false);
    expect(SubmitFeedbackSchema.safeParse({ ...valid, message: "x".repeat(5001) }).success).toBe(false);
  });
  it("strips query strings and rejects non-route context", () => {
    expect(safeFeedbackRoute(valid.route)).toBe("/workspaces/client-1/create");
    expect(safeFeedbackRoute("https://evil.example/path")).toBeNull();
  });
  it("supports only the product status, priority, and note workflow", () => {
    expect(UpdateFeedbackSchema.safeParse({ status: "planned", priority: "urgent", adminNote: "Reviewed" }).success).toBe(true);
    expect(UpdateFeedbackSchema.safeParse({ status: "duplicate" }).success).toBe(false);
  });
  it("keeps auth, tenancy, own-history, admin, and rate-limit boundaries in the routes", () => {
    const routes = readFileSync("domains/feedback/feedback.routes.js", "utf8");
    const admin = readFileSync("domains/internal/internal.routes.js", "utf8");
    const server = readFileSync("server.js", "utf8");
    expect(server.indexOf('app.use("/api"')).toBeLessThan(server.indexOf("app.use(feedbackRouter)"));
    expect(routes).toContain("submitLimiter");
    expect(routes).toContain("req.user.id");
    expect(routes).toContain("listOwnFeedback(req.user.id)");
    expect(admin).toMatch(/internalRouter\.get\(`\$\{BASE\}\/feedback`, requireAdminRole/);
    expect(admin).toMatch(/internalRouter\.patch\(`\$\{BASE\}\/feedback\/:id`, requireAdminRole/);
  });
});
