import { describe, expect, it, vi } from "vitest";

import { queryWorkspaceRetrieval } from "../domains/aiPlatform/retrievalQuery.service.js";

const HASH = `sha256:${"a".repeat(64)}`;

function response(workspaceId = "workspace-a", overrides = {}) {
  const results = [
    {
      text: "Professional local market guidance.",
      citation: {
        workspaceId,
        sourceType: "brand_profile",
        sourceId: "brand-1",
        contentHash: HASH,
        chunkId: "brand-1:0",
        trustClassification: "approved",
        language: "en",
      },
      score: 0.9,
      keywordScore: 1,
      vectorScore: 0.8,
      recencyScore: 1,
      trustScore: 0.9,
      metadata: {},
      containsUntrustedInstruction: false,
    },
  ];
  return {
    schemaVersion: "retrieval-query-response.v1",
    workspaceId,
    purpose: "campaign_context",
    results,
    resultCount: results.length,
    empty: false,
    topK: 3,
    traceId: "trace-1",
    provenance: {
      implementation: "hybrid_retrieval_v1",
      inferenceMode: "deterministic_embedding_hybrid",
      fallbackUsed: false,
      traceId: "trace-python",
    },
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    actor: { auth0Sub: "auth0|owner" },
    workspaceId: "workspace-a",
    query: "local market guidance",
    topK: 3,
    traceId: "trace-1",
    platformEnabled: true,
    retrievalEnabled: true,
    serviceAuthSecret: "test-secret",
    authorizationService: vi.fn(async () => ({ allowed: true })),
    featureFlagEvaluator: vi.fn(async () => true),
    snapshotItems: [
      {
        sourceType: "brand_profile",
        sourceId: "brand-1",
        text: "Professional local market guidance.",
        trust: "approved",
      },
    ],
    pythonClient: vi.fn(async () => ({ ok: true, body: response() })),
    ...overrides,
  };
}

describe("hosted retrieval query", () => {
  it("sends a signed tenant-scoped indexing event and returns hosted provenance", async () => {
    const input = deps();
    const result = await queryWorkspaceRetrieval(input);
    const envelope = input.pythonClient.mock.calls[0][0].envelope;

    expect(envelope.scopes).toEqual(["retrieval:query"]);
    expect(envelope.workspaceId).toBe("workspace-a");
    expect(envelope.payload.indexingEvents[0]).toMatchObject({
      workspaceId: "workspace-a",
      sourceType: "brand_profile",
      sourceId: "brand-1",
      operation: "upsert",
    });
    expect(result.provenance).toMatchObject({
      source: "squadpitch-ai",
      fallbackUsed: false,
      implementation: "hybrid_retrieval_v1",
    });
  });

  it("accepts a valid empty result", async () => {
    const empty = response("workspace-a", {
      results: [],
      resultCount: 0,
      empty: true,
    });
    const result = await queryWorkspaceRetrieval(
      deps({ pythonClient: vi.fn(async () => ({ ok: true, body: empty })) }),
    );
    expect(result.empty).toBe(true);
  });

  it("authorizes before contacting Python", async () => {
    const pythonClient = vi.fn();
    await expect(
      queryWorkspaceRetrieval(
        deps({
          authorizationService: vi.fn(async () => {
            throw Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
          }),
          pythonClient,
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(pythonClient).not.toHaveBeenCalled();
  });

  it("honors both platform and retrieval feature flags", async () => {
    for (const enabledFlags of [
      [false, true],
      [true, false],
    ]) {
      const pythonClient = vi.fn();
      const featureFlagEvaluator = vi
        .fn()
        .mockResolvedValueOnce(enabledFlags[0])
        .mockResolvedValueOnce(enabledFlags[1]);
      await expect(
        queryWorkspaceRetrieval(
          deps({
            platformEnabled: undefined,
            retrievalEnabled: undefined,
            featureFlagEvaluator,
            pythonClient,
          }),
        ),
      ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 404 });
      expect(pythonClient).not.toHaveBeenCalled();
    }
  });

  it("fails closed on provider errors and invalid schemas", async () => {
    await expect(
      queryWorkspaceRetrieval(
        deps({
          pythonClient: vi.fn(async () => ({
            ok: false,
            status: "timeout",
            errorCode: "PROVIDER_TIMEOUT",
          })),
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", status: 504 });

    await expect(
      queryWorkspaceRetrieval(
        deps({
          pythonClient: vi.fn(async () => ({
            ok: true,
            body: response("workspace-a", { resultCount: 99 }),
          })),
        }),
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("rejects cross-tenant responses and citations", async () => {
    await expect(
      queryWorkspaceRetrieval(
        deps({
          pythonClient: vi.fn(async () => ({
            ok: true,
            body: response("workspace-b"),
          })),
        }),
      ),
    ).rejects.toMatchObject({ code: "TENANT_LEAKAGE" });

    const leakedCitation = response();
    leakedCitation.results[0].citation.workspaceId = "workspace-b";
    await expect(
      queryWorkspaceRetrieval(
        deps({
          pythonClient: vi.fn(async () => ({
            ok: true,
            body: leakedCitation,
          })),
        }),
      ),
    ).rejects.toMatchObject({ code: "TENANT_LEAKAGE" });
  });
});
