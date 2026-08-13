// Verifies the P0.5 fix: publishing without a CONNECTED ChannelConnection
// throws CHANNEL_NOT_CONNECTED (HTTP 422). The draft must NOT transition to
// PUBLISHED — that's the regression we're guarding against.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────
// All Prisma + service-module dependencies must be mocked before importing
// the SUT, otherwise importing publishingService.js pulls in real DB code.

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
  client: { lifecycle: "CUSTOMER" },
};

const transitionDraftMock = vi.fn();
const updateConnectionStatusMock = vi.fn().mockResolvedValue(null);
const getConnectionForAdapterMock = vi.fn();
const ensureValidAccessTokenMock = vi.fn();
const refreshConnectionTokenMock = vi.fn();
const formatDraftMock = vi.fn((d) => ({ ...d, _formatted: true }));

vi.mock("../prisma.js", () => ({
  prisma: {
    draft: {
      findUnique: vi.fn().mockResolvedValue({ ...mockDraft }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({ ...mockDraft }),
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
  getAdapterForChannel: vi.fn(),
}));

vi.mock("../domains/notifications/notification.service.js", () => ({
  enqueueNotification: vi.fn(),
}));

vi.mock("../domains/studio/tokenRefreshService.js", () => ({
  ensureValidAccessToken: ensureValidAccessTokenMock,
  refreshConnectionToken: refreshConnectionTokenMock,
}));

const { publishDraft } = await import(
  "../domains/studio/publishing/publishingService.js"
);

describe("publishDraft — no connection behavior (P0.5 regression guard)", () => {
  beforeEach(() => {
    transitionDraftMock.mockReset();
    getConnectionForAdapterMock.mockReset();
    ensureValidAccessTokenMock.mockReset();
  });

  it("manual publish with no ChannelConnection throws CHANNEL_NOT_CONNECTED and never transitions to PUBLISHED", async () => {
    getConnectionForAdapterMock.mockResolvedValue(null);

    await expect(
      publishDraft({ draftId: "draft-1", actorSub: "auth0|x", source: "manual" })
    ).rejects.toMatchObject({
      status: 422,
      code: "CHANNEL_NOT_CONNECTED",
    });

    // Critical: NO transition to PUBLISHED happened.
    expect(transitionDraftMock).not.toHaveBeenCalled();
  });

  it("manual publish with EXPIRED connection throws TOKEN_EXPIRED (distinct from CHANNEL_NOT_CONNECTED)", async () => {
    getConnectionForAdapterMock.mockResolvedValue({
      status: "EXPIRED",
      tokenExpiresAt: new Date(),
    });
    ensureValidAccessTokenMock.mockImplementation(async (c) => c);

    await expect(
      publishDraft({ draftId: "draft-1", actorSub: "auth0|x", source: "manual" })
    ).rejects.toMatchObject({
      status: 422,
      code: "TOKEN_EXPIRED",
      connectionStatus: "EXPIRED",
    });

    expect(transitionDraftMock).not.toHaveBeenCalled();
  });

  it("scheduled publish with no connection also throws (no silent local fallback)", async () => {
    getConnectionForAdapterMock.mockResolvedValue(null);

    await expect(
      publishDraft({
        draftId: "draft-1",
        actorSub: "auth0|x",
        source: "scheduled",
      })
    ).rejects.toMatchObject({
      status: 422,
      code: "CHANNEL_NOT_CONNECTED",
    });

    expect(transitionDraftMock).not.toHaveBeenCalled();
  });
});
