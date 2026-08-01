import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();
const refresh = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: { channelConnection: { updateMany }, user: { findUnique: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("../lib/tokenCrypto.js", () => ({
  encryptToken: (value) => `encrypted:${value}`,
  decryptToken: (value) => String(value).replace(/^encrypted:/, ""),
}));
vi.mock("../redis.js", () => ({
  redisSetNX: vi.fn().mockResolvedValue(true),
  redisCompareDelete: vi.fn().mockResolvedValue(true),
}));
vi.mock("../domains/studio/token-refresh/index.js", () => ({ getRefreshAdapter: () => ({ refresh }) }));
vi.mock("../domains/notifications/notification.service.js", () => ({ enqueueNotification: vi.fn() }));
vi.mock("../lib/logger.js", () => ({ logEvent: vi.fn() }));

describe("Pinterest refresh persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("encrypts rotated tokens, stores both expiries, and coalesces concurrent refreshes", async () => {
    let resolveRefresh;
    refresh.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    const { refreshConnectionToken } = await import("../domains/studio/tokenRefreshService.js");
    const connection = {
      id: "connection-1", clientId: "workspace-1", channel: "PINTEREST",
      accessToken: "old-access", refreshToken: "old-refresh", createdBy: "auth0|user",
    };
    const first = refreshConnectionToken(connection);
    const second = refreshConnectionToken(connection);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const accessExpiry = new Date(Date.now() + 3600_000);
    const refreshExpiry = new Date(Date.now() + 5_000_000);
    resolveRefresh({
      accessToken: "new-access", refreshToken: "new-refresh",
      expiresAt: accessExpiry, refreshTokenExpiresAt: refreshExpiry,
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.accessToken).toBe("new-access");
    expect(b.accessToken).toBe("new-access");
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        accessToken: "encrypted:new-access", refreshToken: "encrypted:new-refresh",
        tokenExpiresAt: accessExpiry, refreshTokenExpiresAt: refreshExpiry,
      }),
    }));
  });

  it("marks revoked authorization for reconnect with a stable code", async () => {
    refresh.mockResolvedValue({
      canRefresh: false, code: "PINTEREST_RECONNECT_REQUIRED",
      error: "Pinterest authorization must be renewed",
    });
    const { refreshConnectionToken } = await import("../domains/studio/tokenRefreshService.js");
    await expect(refreshConnectionToken({
      id: "connection-2", clientId: "workspace-1", channel: "PINTEREST",
      refreshToken: "refresh", createdBy: "auth0|user",
    })).rejects.toMatchObject({ code: "PINTEREST_RECONNECT_REQUIRED" });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "NEEDS_RECONNECT" }),
    }));
  });
});
