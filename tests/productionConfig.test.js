import { describe, expect, it, vi } from "vitest";
import {
  CORE_PRODUCTION_VARS,
  assertProductionConfig,
  inspectProductionConfig,
} from "../config/productionConfig.js";

function validProductionConfig() {
  const config = Object.fromEntries(
    CORE_PRODUCTION_VARS.map((name) => [name, "configured"]),
  );
  return {
    ...config,
    NODE_ENV: "production",
    APP_URL: "https://app.squadpitch.com",
    RUNTIME_REVALIDATE_URL: "https://sites.squadpitch.com/api/revalidate",
    ALLOWED_ORIGINS: "https://app.squadpitch.com",
    ENABLE_WORKERS: true,
    PROCESS_ROLE: "api",
    PINTEREST_USE_SANDBOX: false,
    SMS_SENDING_ENABLED: false,
    SMS_A2P_APPROVED: false,
    SENTRY_DSN: "configured",
    SENTRY_ENVIRONMENT: "production",
    OPENAI_API_KEY: "configured",
    STRIPE_SECRET_KEY: ["sk", "live", "configured"].join("_"),
    STRIPE_EXPECTED_MODE: "live",
    POSTMARK_MESSAGE_STREAM: "outbound",
    NOTIFICATION_FROM_EMAIL: "notifications@example.test",
    INBOX_EMAIL_FROM: "inbox@example.test",
    INBOX_EMAIL_REPLY_DOMAIN: "reply.example.test",
    POSTMARK_INBOUND_WEBHOOK_SECRET: "a".repeat(48),
  };
}

describe("production configuration hardening", () => {
  it("does not enforce production requirements outside production", () => {
    expect(inspectProductionConfig({ NODE_ENV: "test" })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("accepts a complete production configuration", () => {
    expect(inspectProductionConfig(validProductionConfig())).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("reports every missing core setting without exposing values", () => {
    const result = inspectProductionConfig({ NODE_ENV: "production" });
    expect(result.errors.length).toBeGreaterThanOrEqual(
      CORE_PRODUCTION_VARS.length,
    );
    expect(result.errors).toContain("DATABASE_URL is required");
    expect(result.errors).toContain("STRIPE_SECRET_KEY is required");
  });

  it("rejects localhost URLs and unsafe SMS while warning on sandbox publishing", () => {
    const config = {
      ...validProductionConfig(),
      APP_URL: "http://localhost:3000",
      ALLOWED_ORIGINS: "https://app.squadpitch.com,http://127.0.0.1:3000",
      PINTEREST_USE_SANDBOX: true,
      PROCESS_ROLE: "invalid",
      SMS_SENDING_ENABLED: true,
      SMS_A2P_APPROVED: false,
    };
    const { errors, warnings } = inspectProductionConfig(config);
    expect(errors).toContain(
      "APP_URL must be a public HTTPS URL in production",
    );
    expect(errors).toContain(
      "ALLOWED_ORIGINS must be a public HTTPS URL in production",
    );
    expect(warnings).toContain(
      "PINTEREST_USE_SANDBOX is enabled; Pinterest remains beta-only",
    );
    expect(errors).toContain(
      "SMS_SENDING_ENABLED requires SMS_A2P_APPROVED=true",
    );
    expect(errors).toContain(
      "PROCESS_ROLE must be api, worker, or cli in production",
    );
  });

  it("keeps observability and explicit fallback availability as warnings", () => {
    const config = {
      ...validProductionConfig(),
      SENTRY_DSN: undefined,
      SENTRY_ENVIRONMENT: undefined,
      OPENAI_API_KEY: undefined,
    };
    const result = inspectProductionConfig(config);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(3);
  });

  it("warns without crashing when paid billing remains in test mode", () => {
    const config = {
      ...validProductionConfig(),
      STRIPE_SECRET_KEY: ["sk", "test", "configured"].join("_"),
      STRIPE_EXPECTED_MODE: "test",
    };
    const result = inspectProductionConfig(config);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain(
      "Stripe remains in test mode; paid billing is not production-ready",
    );
  });

  it("throws once with actionable production errors", () => {
    const logger = { warn: vi.fn() };
    expect(() =>
      assertProductionConfig(
        { ...validProductionConfig(), DATABASE_URL: undefined },
        logger,
      ),
    ).toThrow(/DATABASE_URL is required/);
  });
});
