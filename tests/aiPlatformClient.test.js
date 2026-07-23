import { describe, expect, it, vi } from "vitest";

import { checkPythonAiPlatformHealth } from "../domains/aiPlatform/pythonAiPlatform.client.js";

describe("Python AI platform internal client", () => {
  it("defaults to disabled and does not call fetch", async () => {
    const fetchImpl = vi.fn();

    await expect(checkPythonAiPlatformHealth({ fetchImpl })).resolves.toMatchObject({
      ok: false,
      enabled: false,
      status: "disabled",
      errorCode: "AI_PLATFORM_DISABLED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks enabled probes outside staging", async () => {
    const fetchImpl = vi.fn();

    await expect(
      checkPythonAiPlatformHealth({
        enabled: true,
        environment: "production",
        baseUrl: "https://squadpitch-ai.internal",
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      ok: false,
      enabled: true,
      status: "blocked",
      errorCode: "AI_PLATFORM_NOT_STAGING",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("performs a successful mocked health check in staging", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", service: "squadpitch-ai" }),
    }));

    await expect(
      checkPythonAiPlatformHealth({
        enabled: true,
        environment: "staging",
        baseUrl: "https://squadpitch-ai.internal/",
        timeoutMs: 1000,
        serviceAuthSecret: "test-secret",
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: true,
      enabled: true,
      status: "ok",
      statusCode: 200,
      service: "squadpitch-ai",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://squadpitch-ai.internal/v1/health/check",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          accept: "application/json",
          "content-type": "application/json",
        }),
        body: expect.any(String),
      }),
    );
    const [, requestInit] = fetchImpl.mock.calls[0];
    const envelope = JSON.parse(requestInit.body);
    expect(envelope).toMatchObject({
      schemaVersion: "ai-service-envelope.v1",
      workspaceId: "system",
      actorUserId: "squadpitch-api",
      scopes: ["health:read"],
      signature: {
        keyId: "primary",
        algorithm: "HMAC-SHA256",
      },
    });
  });

  it("refuses enabled probes when the service auth secret is missing", async () => {
    const fetchImpl = vi.fn();

    await expect(
      checkPythonAiPlatformHealth({
        enabled: true,
        environment: "staging",
        baseUrl: "https://squadpitch-ai.internal",
        serviceAuthSecret: "",
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "not_configured",
      errorCode: "PROVIDER_NOT_CONFIGURED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps timeout errors to shared taxonomy code", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });

    await expect(
      checkPythonAiPlatformHealth({
        enabled: true,
        environment: "staging",
        baseUrl: "https://squadpitch-ai.internal",
        serviceAuthSecret: "test-secret",
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "timeout",
      errorCode: "PROVIDER_TIMEOUT",
    });
  });

  it("maps invalid JSON and non-ok responses", async () => {
    await expect(
      checkPythonAiPlatformHealth({
        enabled: true,
        environment: "staging",
        baseUrl: "https://squadpitch-ai.internal",
        serviceAuthSecret: "test-secret",
        fetchImpl: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("bad json");
          },
        })),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "invalid_response",
      errorCode: "PROVIDER_INVALID_JSON",
    });

    await expect(
      checkPythonAiPlatformHealth({
        enabled: true,
        environment: "staging",
        baseUrl: "https://squadpitch-ai.internal",
        serviceAuthSecret: "test-secret",
        fetchImpl: vi.fn(async () => ({
          ok: false,
          status: 503,
          json: async () => ({ status: "down" }),
        })),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "unavailable",
      statusCode: 503,
      errorCode: "PROVIDER_UNAVAILABLE",
    });
  });
});
