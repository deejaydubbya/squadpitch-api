import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  update: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
  reconnectPrisma: vi.fn(),
  isConnected: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      upsert: mocks.upsert,
      update: mocks.update,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
    },
    client: { updateMany: mocks.updateMany },
    $transaction: mocks.transaction,
  },
  reconnectPrisma: mocks.reconnectPrisma,
  isConnected: mocks.isConnected,
}));

vi.mock("../middleware/auth.js", () => ({
  getAuth0Sub: (req) => req.auth?.payload?.sub,
}));

import { requireUser } from "../middleware/requireUser.js";

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe("requireUser account reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.transaction.mockImplementation((callback) =>
      callback({
        user: {
          findUniqueOrThrow: mocks.findUniqueOrThrow,
          update: mocks.update,
        },
        client: { updateMany: mocks.updateMany },
      }),
    );
    mocks.findUniqueOrThrow.mockResolvedValue({
      auth0Sub: "auth0|old-subject",
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it("preserves the existing user when a verified email has a new Auth0 subject", async () => {
    const collision = Object.assign(new Error("email collision"), {
      code: "P2002",
      meta: { target: ["email"] },
    });
    mocks.upsert.mockRejectedValueOnce(collision);
    mocks.update.mockResolvedValueOnce({
      id: "user-existing",
      email: "owner@example.test",
      auth0Sub: "auth0|new-subject",
    });
    const req = {
      auth: {
        payload: {
          sub: "auth0|new-subject",
          email: "owner@example.test",
          email_verified: true,
        },
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const res = response();
    const next = vi.fn();

    await requireUser(req, res, next);

    expect(mocks.update).toHaveBeenCalledWith({
      where: { email: "owner@example.test" },
      data: { auth0Sub: "auth0|new-subject" },
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { createdBy: "auth0|old-subject" },
      data: { createdBy: "auth0|new-subject" },
    });
    expect(req.user.id).toBe("user-existing");
    expect(req.auth0Sub).toBe("auth0|new-subject");
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not link an existing account using an unverified email", async () => {
    const collision = Object.assign(new Error("email collision"), {
      code: "P2002",
      meta: { target: ["email"] },
    });
    mocks.upsert.mockRejectedValueOnce(collision);
    const req = {
      auth: {
        payload: {
          sub: "auth0|unverified",
          email: "owner@example.test",
          email_verified: false,
        },
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const res = response();

    await requireUser(req, res, vi.fn());

    expect(mocks.update).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("ACCOUNT_LINK_REQUIRED");
  });

  it("confirms verification through Auth0 userinfo when the JWT omits the claim", async () => {
    const collision = Object.assign(new Error("email collision"), {
      code: "P2002",
      meta: { target: ["email"] },
    });
    mocks.upsert.mockRejectedValueOnce(collision);
    mocks.update.mockResolvedValueOnce({
      id: "user-existing",
      email: "owner@example.test",
      auth0Sub: "google-oauth2|subject",
    });
    const auth0Fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        email: "owner@example.test",
        email_verified: true,
      }),
    });
    vi.stubGlobal("fetch", auth0Fetch);
    const req = {
      auth: {
        token: "redacted-test-token",
        payload: {
          sub: "google-oauth2|subject",
          email: "owner@example.test",
        },
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const next = vi.fn();

    await requireUser(req, response(), next);

    expect(auth0Fetch).toHaveBeenCalledOnce();
    expect(auth0Fetch.mock.calls[0][1].headers.authorization).toBe(
      "Bearer redacted-test-token",
    );
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});
