import { describe, expect, it, vi } from "vitest";

import {
  configCheck,
  readinessExitCode,
  summarizeReadiness,
} from "../scripts/production-readiness/classifier.js";
import { runProductionReadinessChecks } from "../scripts/production-readiness/checks.js";

const configuredEnv = {
  NODE_ENV: "production",
  AUTH0_DOMAIN: "tenant.example.test",
  AUTH0_AUDIENCE: "https://api.example.test",
  DATABASE_URL: "postgresql://example",
  REDIS_URL: "redis://example",
  STRIPE_SECRET_KEY: "sk_live_configured",
  STRIPE_EXPECTED_MODE: "live",
  STRIPE_WEBHOOK_SECRET: "configured",
  STRIPE_STARTER_PRICE_ID: "price_starter",
  STRIPE_PRO_PRICE_ID: "price_pro",
  STRIPE_GROWTH_PRICE_ID: "price_growth",
  STRIPE_AGENCY_PRICE_ID: "price_agency",
  POSTMARK_SERVER_TOKEN: "configured",
  POSTMARK_MESSAGE_STREAM: "outbound",
  NOTIFICATION_FROM_EMAIL: "notifications@example.test",
  INBOX_EMAIL_FROM: "hello@example.test",
  INBOX_EMAIL_REPLY_DOMAIN: "reply.example.test",
  POSTMARK_INBOUND_WEBHOOK_SECRET:
    "configured-webhook-secret-at-least-32-chars",
  SMS_SENDING_ENABLED: "false",
  AI_PLATFORM_INTERNAL_BASE_URL: "http://ai.internal:8080",
  AI_PLATFORM_SERVICE_AUTH_KEY_ID: "v1",
  AI_PLATFORM_SERVICE_AUTH_SECRET: "configured",
  SENTRY_DSN: "configured",
  SENTRY_ENVIRONMENT: "production",
  PUBLIC_SITES_BASE_DOMAIN: "sites.example.test",
  RUNTIME_REVALIDATE_URL: "https://sites.example.test/api/revalidate",
  RUNTIME_REVALIDATE_TOKEN: "configured",
  RUNTIME_IP_SALT: "configured",
  META_APP_ID: "configured",
  META_APP_SECRET: "configured",
  META_OAUTH_REDIRECT_URI: "https://app.example.test/callback",
  APP_URL: "https://app.example.test",
};

describe("production readiness classification", () => {
  it("makes only P0 failures exit nonzero", () => {
    expect(
      readinessExitCode([
        { status: "WARN", priority: "P2" },
        { status: "BLOCKED", priority: "P0" },
      ]),
    ).toBe(0);
    expect(readinessExitCode([{ status: "FAIL", priority: "P0" }])).toBe(1);
  });

  it("classifies missing core config as FAIL and optional config as WARN", () => {
    expect(
      configCheck({
        id: "core",
        group: "test",
        variables: ["CORE"],
        env: {},
      }),
    ).toMatchObject({ status: "FAIL", priority: "P0" });
    expect(
      configCheck({
        id: "optional",
        group: "test",
        variables: ["OPTIONAL"],
        required: false,
        env: {},
      }),
    ).toMatchObject({ status: "WARN", priority: "P2" });
  });

  it("summarizes PASS/WARN/BLOCKED/FAIL", () => {
    expect(
      summarizeReadiness([
        { status: "PASS", priority: "P0" },
        { status: "WARN", priority: "P2" },
        { status: "BLOCKED", priority: "P2" },
      ]),
    ).toMatchObject({
      status: "READY_WITH_WARNINGS",
      pass: 1,
      warn: 1,
      blocked: 1,
      fail: 0,
      exitCode: 0,
    });
  });
});

describe("production readiness checks", () => {
  it("supports a deterministic no-network mode without exposing values", async () => {
    const checks = await runProductionReadinessChecks({
      env: configuredEnv,
      network: false,
    });
    expect(checks.some((item) => item.status === "BLOCKED")).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("postgresql://example");
    expect(JSON.stringify(checks)).not.toContain("price_pro");
  });

  it("separates successful configuration from live connectivity", async () => {
    const fetchImpl = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes("api.stripe.com")
          ? { livemode: true, active: true, type: "recurring" }
          : String(url).includes("api.postmarkapp.com")
            ? {
                DeliveryType: "Live",
                InboundHookUrl:
                  "https://api.example.test/api/v1/webhooks/postmark/inbound",
              }
            : {},
    }));
    const checks = await runProductionReadinessChecks({
      env: {
        ...configuredEnv,
        TWILIO_ACCOUNT_SID: "account",
        TWILIO_AUTH_TOKEN: "token",
        TWILIO_FROM_NUMBER: "+15555550100",
      },
      fetchImpl,
      databaseProbe: vi.fn(async () => ({
        ok: true,
        message: "Database probe succeeded",
      })),
      redisProbe: vi.fn(async () => ({
        ok: true,
        message: "Redis probe succeeded",
      })),
    });
    expect(checks.find((item) => item.id === "auth0.config")?.kind).toBe(
      "configuration",
    );
    expect(
      checks.find((item) => item.id === "auth0.connectivity"),
    ).toMatchObject({ kind: "connectivity", status: "PASS" });
    expect(checks.every((item) => item.status !== "FAIL")).toBe(true);
  });

  it("fails dangerous production SMS flags", async () => {
    const checks = await runProductionReadinessChecks({
      env: {
        ...configuredEnv,
        SMS_SENDING_ENABLED: "true",
        SMS_A2P_APPROVED: "false",
      },
      network: false,
    });
    expect(checks.find((item) => item.id === "flags.sms-a2p")).toMatchObject({
      status: "FAIL",
      priority: "P0",
    });
  });
});
