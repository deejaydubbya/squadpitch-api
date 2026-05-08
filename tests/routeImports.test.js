// Boot-time smoke: every router module must import cleanly. Catches
// import typos like `requireAdminRoleRole` that would crash on the
// first request hitting the affected route — but only at production
// boot time, never in any unit test.
//
// We mock the heavyweight singletons (Prisma, Redis, BullMQ) so the
// test runs in milliseconds without needing infrastructure. The goal
// is purely "did all named exports resolve?".

import { describe, it, expect, vi } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: new Proxy({}, { get: () => () => Promise.resolve(null) }),
  isConnected: () => Promise.resolve(true),
}));

vi.mock("../redis.js", () => ({
  getRedisConnection: () => null,
  getRedis: () => null,
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisSetNX: vi.fn(),
  redisDel: vi.fn(),
  redisPing: vi.fn().mockResolvedValue(false),
}));

vi.mock("bullmq", () => ({
  Queue: class { add() {} close() {} },
  Worker: class { on() {} close() {} },
}));

// studio.routes.js + billing.routes.js pull in the entire studio
// service graph (publishing adapters, metrics adapters, auto-schedule,
// listing ingestion, etc). Cold imports legitimately take 6–10s on
// CI cold-cache. Per-test bump from the default 5s.
const ROUTE_IMPORT_TIMEOUT_MS = 30_000;

describe("API route module boot smoke", () => {
  it(
    "billing.routes loads without import errors",
    async () => {
      const mod = await import("../domains/billing/billing.routes.js");
      expect(mod.billingRouter).toBeTruthy();
    },
    ROUTE_IMPORT_TIMEOUT_MS,
  );

  it(
    "studio.routes loads without import errors",
    async () => {
      const mod = await import("../domains/studio/studio.routes.js");
      expect(mod.studioRouter).toBeTruthy();
    },
    ROUTE_IMPORT_TIMEOUT_MS,
  );

  it("internal.routes loads without import errors", async () => {
    const mod = await import("../domains/internal/internal.routes.js");
    expect(mod.internalRouter).toBeTruthy();
  });

  it("notifications/webhook.routes loads without import errors", async () => {
    const mod = await import("../domains/notifications/webhook.routes.js");
    expect(mod.webhookRouter).toBeTruthy();
  });

  it("notifications/notification.routes loads without import errors", async () => {
    const mod = await import("../domains/notifications/notification.routes.js");
    expect(mod.notificationRouter).toBeTruthy();
  });

  it("integrations/mediaImport.routes loads without import errors", async () => {
    const mod = await import("../domains/integrations/mediaImport.routes.js");
    expect(mod.mediaImportRouter).toBeTruthy();
  });

  it("integrations/integration.routes loads without import errors", async () => {
    const mod = await import("../domains/integrations/integration.routes.js");
    expect(mod.integrationRouter).toBeTruthy();
  });

  it("notifications/slack.routes loads without import errors", async () => {
    const mod = await import("../domains/notifications/slack.routes.js");
    expect(mod.slackRouter).toBeTruthy();
  });

  it("studio/conversion.routes loads without import errors", async () => {
    const mod = await import("../domains/studio/conversion.routes.js");
    expect(mod.conversionPublicRouter).toBeTruthy();
  });

  it("industry/industry.routes loads without import errors", async () => {
    const mod = await import("../domains/industry/industry.routes.js");
    expect(mod.industryRouter).toBeTruthy();
  });
});
