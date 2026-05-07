// Schema-level guards for the internal/* admin mutation routes.
//
// These tests exist to prove two contracts:
//   1. Invalid bodies are rejected by Zod (not passed to Prisma).
//   2. Unknown / dangerous fields are silently dropped — the parsed.data
//      we feed to services never carries `id`, `userId`, `createdAt`, etc.,
//      that an admin could otherwise smuggle into Prisma.

import { describe, it, expect } from "vitest";
import {
  CreateExternalServiceSchema,
  UpdateExternalServiceSchema,
  CreateBetaTesterSchema,
  UpdateBetaTesterSchema,
  CreateBetaFeedbackSchema,
  UpdateBetaFeedbackSchema,
  CreateFeatureFlagSchema,
  UpdateFeatureFlagSchema,
  ToggleFeatureFlagSchema,
  ToggleWebhookEndpointSchema,
} from "../domains/internal/internal.schemas.js";

describe("CreateExternalServiceSchema", () => {
  it("accepts a minimal valid service", () => {
    const r = CreateExternalServiceSchema.safeParse({
      key: "openai",
      name: "OpenAI",
      category: "ai",
      purpose: "Text generation",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown category", () => {
    const r = CreateExternalServiceSchema.safeParse({
      key: "openai",
      name: "OpenAI",
      category: "wat",
      purpose: "x",
    });
    expect(r.success).toBe(false);
  });

  it("strips smuggled fields (id, createdAt, updatedAt)", () => {
    const r = CreateExternalServiceSchema.safeParse({
      key: "fal",
      name: "Fal",
      category: "ai",
      purpose: "Images",
      id: "evil",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
      percentUsed: 999,
    });
    expect(r.success).toBe(true);
    expect(r.data.id).toBeUndefined();
    expect(r.data.createdAt).toBeUndefined();
    expect(r.data.updatedAt).toBeUndefined();
    // percentUsed is also not in the schema — should be stripped.
    expect(r.data.percentUsed).toBeUndefined();
  });
});

describe("UpdateExternalServiceSchema", () => {
  it("does not allow flipping the key", () => {
    const r = UpdateExternalServiceSchema.safeParse({
      key: "different",
      name: "X",
    });
    expect(r.success).toBe(true);
    // Even if the parse succeeds, `key` is omitted from the schema.
    expect(r.data.key).toBeUndefined();
  });
});

describe("CreateBetaTesterSchema", () => {
  it("requires a valid email", () => {
    const r = CreateBetaTesterSchema.safeParse({
      userId: "auth0|abc",
      email: "not-an-email",
    });
    expect(r.success).toBe(false);
  });

  it("strips id and any extra fields", () => {
    const r = CreateBetaTesterSchema.safeParse({
      userId: "auth0|abc",
      email: "x@y.com",
      id: "tester-1",
      createdAt: "2024-01-01",
    });
    expect(r.success).toBe(true);
    expect(r.data.id).toBeUndefined();
    expect(r.data.createdAt).toBeUndefined();
  });
});

describe("UpdateBetaTesterSchema", () => {
  it("does not allow changing userId", () => {
    const r = UpdateBetaTesterSchema.safeParse({
      userId: "auth0|new-identity",
      status: "paused",
    });
    expect(r.success).toBe(true);
    expect(r.data.userId).toBeUndefined();
    expect(r.data.status).toBe("paused");
  });
});

describe("CreateBetaFeedbackSchema", () => {
  it("rejects empty title", () => {
    const r = CreateBetaFeedbackSchema.safeParse({
      title: "",
      body: "Some body",
    });
    expect(r.success).toBe(false);
  });

  it("strips smuggled status (admin must use UpdateBetaFeedbackSchema)", () => {
    const r = CreateBetaFeedbackSchema.safeParse({
      title: "Found a bug",
      body: "details",
      status: "resolved", // <- not in create schema
      assignee: "auth0|admin",
    });
    expect(r.success).toBe(true);
    expect(r.data.status).toBeUndefined();
    expect(r.data.assignee).toBeUndefined();
  });
});

describe("UpdateBetaFeedbackSchema", () => {
  it("rejects an unknown status", () => {
    const r = UpdateBetaFeedbackSchema.safeParse({ status: "yolo" });
    expect(r.success).toBe(false);
  });

  it("does NOT allow rewriting body or title", () => {
    const r = UpdateBetaFeedbackSchema.safeParse({
      title: "rewrite",
      body: "rewrite",
      status: "triaged",
    });
    expect(r.success).toBe(true);
    expect(r.data.title).toBeUndefined();
    expect(r.data.body).toBeUndefined();
    expect(r.data.status).toBe("triaged");
  });
});

describe("CreateFeatureFlagSchema", () => {
  it("requires targetType + targetIds when scope is targeted", () => {
    const r = CreateFeatureFlagSchema.safeParse({
      key: "video_gen_beta",
      name: "Video gen beta",
      scope: "targeted",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a global flag without target details", () => {
    const r = CreateFeatureFlagSchema.safeParse({
      key: "video_gen_beta",
      name: "Video gen beta",
      scope: "global",
    });
    expect(r.success).toBe(true);
  });

  it("rejects rolloutPercentage outside 0–100", () => {
    const r = CreateFeatureFlagSchema.safeParse({
      key: "x",
      name: "X",
      rolloutPercentage: 150,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid key shape", () => {
    const r = CreateFeatureFlagSchema.safeParse({
      key: "Bad Key With Spaces!",
      name: "Whatever",
    });
    expect(r.success).toBe(false);
  });

  it("strips createdBy / updatedBy if smuggled (route fills these from the JWT)", () => {
    const r = CreateFeatureFlagSchema.safeParse({
      key: "x",
      name: "X",
      createdBy: "auth0|spoofed",
      updatedBy: "auth0|spoofed",
    });
    expect(r.success).toBe(true);
    expect(r.data.createdBy).toBeUndefined();
    expect(r.data.updatedBy).toBeUndefined();
  });
});

describe("UpdateFeatureFlagSchema", () => {
  it("does not allow changing the flag key", () => {
    const r = UpdateFeatureFlagSchema.safeParse({
      key: "wholly_new_key",
      name: "X",
    });
    expect(r.success).toBe(true);
    expect(r.data.key).toBeUndefined();
  });
});

describe("ToggleFeatureFlagSchema and ToggleWebhookEndpointSchema", () => {
  it("require a boolean", () => {
    expect(ToggleFeatureFlagSchema.safeParse({ enabled: "true" }).success).toBe(false);
    expect(ToggleFeatureFlagSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(ToggleWebhookEndpointSchema.safeParse({ isActive: 1 }).success).toBe(false);
    expect(ToggleWebhookEndpointSchema.safeParse({ isActive: false }).success).toBe(true);
  });
});
