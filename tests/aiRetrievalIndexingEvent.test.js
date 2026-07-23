import { describe, expect, it, vi } from "vitest";

import {
  AI_RETRIEVAL_INDEXING_EVENT_SCHEMA_VERSION,
  aiRetrievalIndexingEventSchema,
  createAuthorizedAiRetrievalIndexingEvent,
} from "../domains/aiPlatform/retrievalIndexingEvent.js";

const CONTENT_HASH = `sha256:${"a".repeat(64)}`;

describe("AI retrieval indexing events", () => {
  it("authorizes and creates a typed indexing event with workspace scope", async () => {
    const authorizationService = vi.fn(async () => ({ allowed: true }));

    const event = await createAuthorizedAiRetrievalIndexingEvent({
      actor: { auth0Sub: "auth0|owner" },
      workspaceId: "workspace-a",
      sourceType: "property_listing",
      sourceId: "property-a",
      trustClassification: "authoritative",
      contentHash: CONTENT_HASH,
      payload: { workspaceId: "workspace-a", approvedText: "123 Cedar Ave has 3 beds." },
      requestId: "req-1",
      traceId: "trace-1",
      eventId: "event-1",
      sourceUpdatedAt: new Date("2026-07-22T12:00:00.000Z"),
      authorizationService,
    });

    expect(authorizationService).toHaveBeenCalledWith({
      actor: { auth0Sub: "auth0|owner" },
      workspaceId: "workspace-a",
      scope: "retrieval:query",
      allowAdmin: false,
    });
    expect(event.schemaVersion).toBe(AI_RETRIEVAL_INDEXING_EVENT_SCHEMA_VERSION);
    expect(aiRetrievalIndexingEventSchema.parse(event)).toEqual(event);
  });

  it("rejects cross-workspace payloads before publishing", async () => {
    await expect(
      createAuthorizedAiRetrievalIndexingEvent({
        actor: { auth0Sub: "auth0|owner" },
        workspaceId: "workspace-a",
        sourceType: "draft",
        sourceId: "draft-a",
        trustClassification: "approved",
        contentHash: CONTENT_HASH,
        payload: { workspaceId: "workspace-b", approvedText: "wrong workspace" },
        authorizationService: vi.fn(async () => ({ allowed: true })),
      }),
    ).rejects.toThrow("payload workspaceId must match event workspaceId");
  });

  it("does not let the feature flag bypass authorization", async () => {
    await expect(
      createAuthorizedAiRetrievalIndexingEvent({
        actor: { auth0Sub: "auth0|other" },
        workspaceId: "workspace-a",
        sourceType: "property_listing",
        sourceId: "property-a",
        trustClassification: "authoritative",
        contentHash: CONTENT_HASH,
        payload: { workspaceId: "workspace-a", featureFlags: { ai_retrieval_enabled: true } },
        authorizationService: async () => {
          const err = new Error("denied");
          err.code = "NOT_WORKSPACE_OWNER";
          throw err;
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_WORKSPACE_OWNER" });
  });
});
