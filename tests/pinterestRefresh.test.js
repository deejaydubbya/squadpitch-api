import { beforeEach, describe, expect, it, vi } from "vitest";

const env = {
  PINTEREST_CLIENT_ID: "client-id",
  PINTEREST_CLIENT_SECRET: "client-secret",
  PINTEREST_USE_SANDBOX: false,
};
vi.mock("../config/env.js", () => ({ env }));

describe("Pinterest continuous token refresh", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses Basic authentication and returns rotated token metadata", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 5_000_000;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        refresh_token_expires_at: expiresAt,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { pinterestRefresh } = await import("../domains/studio/token-refresh/pinterest.refresh.js");
    const result = await pinterestRefresh.refresh({ refreshToken: "old-refresh" });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.pinterest.com/v5/oauth/token");
    expect(request.headers.Authorization).toMatch(/^Basic /);
    expect(request.headers.Authorization).not.toContain("old-refresh");
    expect(String(request.body)).toContain("grant_type=refresh_token");
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
    expect(result.refreshTokenExpiresAt).toEqual(new Date(expiresAt * 1000));
  });

  it("requires reconnect for invalid_grant without exposing provider details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant", error_description: "sensitive provider detail" }),
    }));
    const { pinterestRefresh } = await import("../domains/studio/token-refresh/pinterest.refresh.js");
    await expect(pinterestRefresh.refresh({ refreshToken: "expired" })).resolves.toMatchObject({
      canRefresh: false,
      code: "PINTEREST_RECONNECT_REQUIRED",
    });
  });

  it("classifies rate limits and transport failures as temporary", async () => {
    const { pinterestRefresh } = await import("../domains/studio/token-refresh/pinterest.refresh.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    await expect(pinterestRefresh.refresh({ refreshToken: "refresh" })).rejects.toMatchObject({
      code: "PINTEREST_UNAVAILABLE",
      transient: true,
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network timeout")));
    await expect(pinterestRefresh.refresh({ refreshToken: "refresh" })).rejects.toMatchObject({
      code: "PINTEREST_UNAVAILABLE",
      transient: true,
    });
  });
});
