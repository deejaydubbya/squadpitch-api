// Adapter-side reliability tests for publishDraft:
//   - PROVIDER_TIMEOUT bubbles up and the draft never becomes PUBLISHED
//   - 401 → PROVIDER_AUTH_FAILED
//   - 429 → RATE_LIMITED
//   - 400 → VALIDATION_FAILED
//   - adapter resolves without externalPostId → PROVIDER_NO_EXTERNAL_ID
//     and the draft never becomes PUBLISHED

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDraft = {
  id: "draft-1",
  clientId: "client-1",
  channel: "INSTAGRAM",
  status: "APPROVED",
  body: "Hello world",
  mediaUrl: "https://example.com/img.jpg",
  mediaType: "image",
  warnings: [],
  idempotencyKey: null,
  publishAttempts: 0,
};

const transitionDraftMock = vi.fn();
const updateConnectionStatusMock = vi.fn().mockResolvedValue(null);
const getConnectionForAdapterMock = vi.fn();
const ensureValidAccessTokenMock = vi.fn(async (c) => c);
const formatDraftMock = vi.fn((d) => ({ ...d, _formatted: true }));
const adapterPublishMock = vi.fn();
const draftUpdateMock = vi.fn().mockResolvedValue({ ...mockDraft });

// Force a short timeout (clamped to 1s minimum by the helper) so the
// timeout test doesn't slow the suite.
vi.mock("../config/env.js", () => ({
  env: { PUBLISH_ADAPTER_TIMEOUT_MS: "1000" },
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    draft: {
      findUnique: vi.fn().mockResolvedValue({ ...mockDraft }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: draftUpdateMock,
    },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("../domains/studio/draftWorkflow.service.js", () => ({
  transitionDraft: transitionDraftMock,
}));

vi.mock("../domains/studio/connection.service.js", () => ({
  getConnectionForAdapter: getConnectionForAdapterMock,
  updateConnectionStatus: updateConnectionStatusMock,
}));

vi.mock("../domains/studio/draft.service.js", () => ({
  formatDraft: formatDraftMock,
}));

vi.mock("../domains/studio/publishing/channelAdapters/index.js", () => ({
  getAdapterForChannel: () => ({ publishPost: adapterPublishMock }),
}));

vi.mock("../domains/notifications/notification.service.js", () => ({
  enqueueNotification: vi.fn(),
}));

vi.mock("../domains/studio/tokenRefreshService.js", () => ({
  ensureValidAccessToken: ensureValidAccessTokenMock,
}));

const { publishDraft } = await import(
  "../domains/studio/publishing/publishingService.js"
);

beforeEach(() => {
  transitionDraftMock.mockReset();
  adapterPublishMock.mockReset();
  draftUpdateMock.mockClear();
  // Default: connected, valid token
  getConnectionForAdapterMock.mockResolvedValue({
    status: "CONNECTED",
    tokenExpiresAt: new Date(Date.now() + 86_400_000),
  });
});

describe("publishDraft — adapter reliability and classification", () => {
  it("classifies a hung adapter as PROVIDER_TIMEOUT and never marks PUBLISHED", async () => {
    adapterPublishMock.mockReturnValue(new Promise(() => {})); // never resolves
    const start = Date.now();
    await expect(
      publishDraft({ draftId: "draft-1", actorSub: "auth0|x", source: "manual" })
    ).rejects.toMatchObject({
      status: 504,
      code: "PROVIDER_TIMEOUT",
    });
    // Mocked env clamp = 1s. Bound the wall time loosely so the test stays
    // fast on slow CI machines.
    expect(Date.now() - start).toBeLessThan(2500);
    expect(transitionDraftMock).not.toHaveBeenCalled();
  }, 5000);

  it("classifies a 401 from the provider as PROVIDER_AUTH_FAILED", async () => {
    adapterPublishMock.mockRejectedValue(
      Object.assign(new Error("token revoked"), { status: 401 })
    );
    await expect(
      publishDraft({ draftId: "draft-1", actorSub: "auth0|x", source: "manual" })
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
    expect(transitionDraftMock).not.toHaveBeenCalled();
    // Auth-ish failure also flips the connection to ERROR
    expect(updateConnectionStatusMock).toHaveBeenCalledWith(
      "client-1",
      "INSTAGRAM",
      expect.objectContaining({ status: "ERROR" })
    );
  });

  it("classifies a 429 as RATE_LIMITED", async () => {
    adapterPublishMock.mockRejectedValue(
      Object.assign(new Error("too many requests"), { status: 429 })
    );
    await expect(
      publishDraft({ draftId: "draft-1", actorSub: "auth0|x", source: "manual" })
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(transitionDraftMock).not.toHaveBeenCalled();
  });

  it("classifies a 400 as VALIDATION_FAILED", async () => {
    adapterPublishMock.mockRejectedValue(
      Object.assign(new Error("caption invalid"), { status: 400 })
    );
    await expect(
      publishDraft({ draftId: "draft-1", actorSub: "auth0|x", source: "manual" })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(transitionDraftMock).not.toHaveBeenCalled();
  });

  it("refuses to mark PUBLISHED when the adapter resolves without externalPostId", async () => {
    adapterPublishMock.mockResolvedValue({ externalPostId: null, externalPostUrl: null });
    await expect(
      publishDraft({ draftId: "draft-1", actorSub: "auth0|x", source: "manual" })
    ).rejects.toMatchObject({ code: "PROVIDER_NO_EXTERNAL_ID" });
    expect(transitionDraftMock).not.toHaveBeenCalled();
  });

  it("happy path: adapter returns externalPostId → draft transitions to PUBLISHED", async () => {
    adapterPublishMock.mockResolvedValue({
      externalPostId: "ig_abc",
      externalPostUrl: "https://instagram.com/p/ig_abc",
    });
    transitionDraftMock.mockResolvedValue({ ...mockDraft, status: "PUBLISHED" });
    await publishDraft({ draftId: "draft-1", actorSub: "auth0|x", source: "manual" });
    expect(transitionDraftMock).toHaveBeenCalledWith(
      "draft-1",
      "PUBLISHED",
      "auth0|x",
      expect.objectContaining({
        externalPostId: "ig_abc",
        externalPostUrl: "https://instagram.com/p/ig_abc",
      })
    );
  });
});
