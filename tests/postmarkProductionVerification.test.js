import { describe, expect, it } from "vitest";
import {
  assertSyntheticScope,
  loadSafeConfig,
} from "../scripts/postmark-production-verification/index.js";

const base = {
  POSTMARK_CANARY_API_BASE_URL: "https://squadpitch-api.fly.dev",
  POSTMARK_CANARY_ACCESS_TOKEN: "not-a-real-token",
  POSTMARK_CANARY_WORKSPACE_ID: "synthetic-workspace",
  POSTMARK_CANARY_ALLOWED_WORKSPACE_ID: "synthetic-workspace",
  POSTMARK_CANARY_CONVERSATION_ID: "synthetic-conversation",
  POSTMARK_CANARY_RECIPIENT: "canary@example.test",
  POSTMARK_CANARY_ALLOWED_RECIPIENT: "canary@example.test",
};

describe("Postmark production verification safety", () => {
  it("accepts only an HTTPS, exactly allowlisted scope", () => {
    expect(loadSafeConfig(base)).toMatchObject({
      workspaceId: "synthetic-workspace",
      recipient: "canary@example.test",
    });
    expect(() =>
      loadSafeConfig({ ...base, POSTMARK_CANARY_RECIPIENT: "customer@example.test" }),
    ).toThrow(/allowlist/);
    expect(() =>
      loadSafeConfig({ ...base, POSTMARK_CANARY_API_BASE_URL: "http://localhost" }),
    ).toThrow(/HTTPS/);
  });

  it("rejects customer, wrong-workspace, and unmarked conversations", () => {
    const config = loadSafeConfig(base);
    const conversation = {
      id: "synthetic-conversation",
      subject: "[SYNTHETIC CANARY] Email",
      contact: { name: "Canary", email: "canary@example.test" },
    };
    expect(() => assertSyntheticScope(config, conversation)).not.toThrow();
    expect(() =>
      assertSyntheticScope({ ...config, workspaceId: "customer-workspace" }, conversation),
    ).toThrow(/workspace/i);
    expect(() =>
      assertSyntheticScope(config, { ...conversation, subject: "Ordinary conversation" }),
    ).toThrow(/SYNTHETIC CANARY/);
  });
});
