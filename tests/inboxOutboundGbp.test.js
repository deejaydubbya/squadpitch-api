// Outbound GBP review reply.
//
// Pins spinstr413 tasks F.6 (route refuses when capability
// missing), F.7 (send only on explicit user action — covered
// structurally by the API gate), F.9 (idempotency key dedupes),
// F.11 (token refresh path), F.12 (Google API failure surfaces
// FAILED state).

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaState;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaState;
  },
}));

const cryptoMock = {
  decryptToken: vi.fn((t) => `plain:${t}`),
  encryptToken: vi.fn((t) => `enc:${t}`),
};
vi.mock("../lib/tokenCrypto.js", () => cryptoMock);

const oauthMock = {
  GBP_SCOPES: ["https://www.googleapis.com/auth/business.manage"],
  updateReply: vi.fn(),
  refreshAccessToken: vi.fn(),
};
vi.mock("../domains/studio/oauth/googleBusinessProfile.oauth.js", () => oauthMock);

const svc = await import("../domains/inbox/inbox.outbound.gbp.service.js");

const CLIENT_A = "client-a";
const CONV_ID = "conv-1";
const REVIEW_NAME = "accounts/100/locations/A1/reviews/r1";

function baseFixture({ overrides = {} } = {}) {
  const messages = [];
  let messageCounter = 0;
  const conversation = {
    id: CONV_ID,
    clientId: CLIENT_A,
    provider: "GOOGLE_BUSINESS",
    spam: false,
    messages: [
      {
        id: "m-rev",
        party: "CONTACT",
        externalMessageId: REVIEW_NAME,
        ...overrides.reviewMsg,
      },
    ],
    ...overrides.conversation,
  };
  const connection = {
    id: "conn-1",
    clientId: CLIENT_A,
    channel: "GOOGLE_BUSINESS_PROFILE",
    status: "CONNECTED",
    externalAccountId: "accounts/100/locations/A1",
    accessToken: "enc-A",
    refreshToken: "enc-RT",
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    ...overrides.connection,
  };
  return {
    conversation: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.id !== conversation.id || where.clientId !== conversation.clientId)
          return null;
        return conversation;
      }),
      update: vi.fn(async () => ({})),
    },
    channelConnection: {
      findUnique: vi.fn(async ({ where }) => {
        if (overrides.noConnection) return null;
        if (where.clientId_channel?.clientId !== connection.clientId) return null;
        if (where.clientId_channel?.channel !== connection.channel) return null;
        return connection;
      }),
      update: vi.fn(async () => ({})),
    },
    message: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.conversationId && where.idempotencyKey) {
          return messages.find(
            (m) =>
              m.conversationId === where.conversationId &&
              m.idempotencyKey === where.idempotencyKey,
          ) ?? null;
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        if (data.idempotencyKey) {
          const collide = messages.find(
            (m) => m.conversationId === data.conversationId && m.idempotencyKey === data.idempotencyKey,
          );
          if (collide) {
            const err = new Error("P2002");
            err.code = "P2002";
            throw err;
          }
        }
        const id = `msg-${++messageCounter}`;
        const row = { id, createdAt: new Date(), ...data };
        messages.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const idx = messages.findIndex((m) => m.id === where.id);
        if (idx === -1) throw new Error("not found");
        messages[idx] = { ...messages[idx], ...data };
        return messages[idx];
      }),
    },
    _state: { messages, connection, conversation },
  };
}

beforeEach(() => {
  oauthMock.updateReply.mockReset().mockResolvedValue({ comment: "ok" });
  oauthMock.refreshAccessToken.mockReset();
});

// ── Capability gate ────────────────────────────────────────────────────

describe("sendGbpReviewReply — capability gate (refuse early)", () => {
  it("refuses with PROVIDER_NOT_AVAILABLE when no GBP connection exists", async () => {
    prismaState = baseFixture({ overrides: { noConnection: true } });
    await expect(
      svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", { body: "Thanks!" }),
    ).rejects.toMatchObject({ status: 412, code: "PROVIDER_NOT_AVAILABLE" });
    expect(oauthMock.updateReply).not.toHaveBeenCalled();
  });

  it("refuses when externalAccountId hasn't been upgraded to a location", async () => {
    prismaState = baseFixture({
      overrides: {
        connection: { externalAccountId: "accounts/100" /* no /locations/ */ },
      },
    });
    await expect(
      svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", { body: "Thanks!" }),
    ).rejects.toMatchObject({ status: 412, code: "PROVIDER_NOT_AVAILABLE" });
  });

  it("refuses when business.manage scope is missing", async () => {
    prismaState = baseFixture({
      overrides: { connection: { scopes: ["something_else"] } },
    });
    await expect(
      svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", { body: "Thanks!" }),
    ).rejects.toMatchObject({ status: 412, code: "PROVIDER_NOT_AVAILABLE" });
  });

  it("refuses with WRONG_PROVIDER when conversation provider is not GOOGLE_BUSINESS", async () => {
    prismaState = baseFixture({
      overrides: { conversation: { provider: "FACEBOOK" } },
    });
    await expect(
      svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", { body: "Thanks!" }),
    ).rejects.toMatchObject({ status: 412, code: "WRONG_PROVIDER" });
  });

  it("refuses with NO_INBOUND_REVIEW when the conversation has no inbound message", async () => {
    prismaState = baseFixture({});
    prismaState.conversation.findFirst.mockResolvedValueOnce({
      ...prismaState._state.conversation,
      messages: [],
    });
    await expect(
      svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", { body: "Thanks!" }),
    ).rejects.toMatchObject({ status: 404, code: "NO_INBOUND_REVIEW" });
  });

  it("refuses with 404 when conversation is in a different workspace (tenant isolation)", async () => {
    prismaState = baseFixture({});
    await expect(
      svc.sendGbpReviewReply("client-B", CONV_ID, "auth0|u1", { body: "Thanks!" }),
    ).rejects.toMatchObject({ status: 404, code: "CONVERSATION_NOT_FOUND" });
  });
});

// ── Happy path ─────────────────────────────────────────────────────────

describe("sendGbpReviewReply — happy path", () => {
  it("creates SENDING message, calls updateReply, flips to SENT with provider id", async () => {
    prismaState = baseFixture({});
    const result = await svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", {
      body: "Thanks for the review!",
    });
    expect(result.deliveryStatus).toBe("SENT");
    expect(result.providerMessageId).toBe(REVIEW_NAME);
    expect(result.externalMessageId).toBe(`${REVIEW_NAME}/reply`);
    expect(oauthMock.updateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewName: REVIEW_NAME,
        comment: "Thanks for the review!",
      }),
    );
  });

  it("refreshes the access token when it's near expiry before calling updateReply", async () => {
    prismaState = baseFixture({
      overrides: {
        connection: { tokenExpiresAt: new Date(Date.now() + 30_000) }, // 30s left
      },
    });
    oauthMock.refreshAccessToken.mockResolvedValue({ accessToken: "AT-NEW", expiresIn: 3600 });
    await svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", { body: "ok" });
    expect(oauthMock.refreshAccessToken).toHaveBeenCalled();
    expect(oauthMock.updateReply).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "AT-NEW" }),
    );
  });
});

// ── Idempotency ────────────────────────────────────────────────────────

describe("sendGbpReviewReply — idempotency", () => {
  it("returns the same Message on a repeated idempotency key (no second updateReply call)", async () => {
    prismaState = baseFixture({});
    const first = await svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", {
      body: "Thanks!",
      idempotencyKey: "uuid-1",
    });
    expect(oauthMock.updateReply).toHaveBeenCalledTimes(1);
    const second = await svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", {
      body: "Thanks!",
      idempotencyKey: "uuid-1",
    });
    expect(oauthMock.updateReply).toHaveBeenCalledTimes(1); // still one call
    expect(second.id).toBe(first.id);
  });

  it("returns 409 SEND_IN_PROGRESS when a prior attempt is still SENDING", async () => {
    prismaState = baseFixture({});
    // Pre-seed a SENDING message with the same key.
    prismaState._state.messages.push({
      id: "msg-inflight",
      conversationId: CONV_ID,
      idempotencyKey: "uuid-inflight",
      deliveryStatus: "SENDING",
      body: "in-flight",
    });
    await expect(
      svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", {
        body: "retry",
        idempotencyKey: "uuid-inflight",
      }),
    ).rejects.toMatchObject({ status: 409, code: "SEND_IN_PROGRESS" });
  });
});

// ── Failure surfacing ──────────────────────────────────────────────────

describe("sendGbpReviewReply — provider failures", () => {
  it("flips message to FAILED with errorReason when updateReply throws 400", async () => {
    prismaState = baseFixture({});
    const apiErr = new Error("Reply too long");
    apiErr.status = 400;
    oauthMock.updateReply.mockRejectedValue(apiErr);
    await expect(
      svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", { body: "..." }),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED", status: 502 });
    const failedRow = prismaState._state.messages[0];
    expect(failedRow.deliveryStatus).toBe("FAILED");
    expect(failedRow.errorReason).toMatch(/Reply too long/);
  });

  it("classifies 5xx as PROVIDER_UNREACHABLE (transient)", async () => {
    prismaState = baseFixture({});
    const apiErr = new Error("Internal error");
    apiErr.status = 500;
    oauthMock.updateReply.mockRejectedValue(apiErr);
    await expect(
      svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", { body: "..." }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNREACHABLE", status: 503 });
  });

  it("flips message to FAILED when token refresh fails (no provider call attempted)", async () => {
    prismaState = baseFixture({
      overrides: {
        connection: { tokenExpiresAt: new Date(Date.now() + 30_000) },
      },
    });
    oauthMock.refreshAccessToken.mockRejectedValue(new Error("Refresh denied"));
    await expect(
      svc.sendGbpReviewReply(CLIENT_A, CONV_ID, "auth0|u1", { body: "..." }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNREACHABLE" });
    expect(oauthMock.updateReply).not.toHaveBeenCalled();
    const failedRow = prismaState._state.messages[0];
    expect(failedRow.deliveryStatus).toBe("FAILED");
    expect(failedRow.errorReason).toMatch(/token_refresh/);
  });
});
